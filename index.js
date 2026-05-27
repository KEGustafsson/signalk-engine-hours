const { readFile, writeFile, rename } = require('fs/promises');
const { join } = require('path');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours Logger';
  plugin.description =
    'Persistent engine hour logger. Log all engines, which report revolutions to SignalK';

  // Validates a SignalK propulsion path. Shared by the file loader and the
  // PUT endpoint so untrusted data cannot reach the persisted store / web UI.
  const VALID_PATH = /^propulsion\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.]+$/;
  // Upper bound on engines accepted in a single PUT — guards against unbounded
  // payloads exhausting memory / disk.
  const MAX_ENGINES = 64;
  // Accrual is capped at this many sampling periods to absorb a couple of
  // missed updates without counting a long data gap / forward clock jump as
  // continuous runtime.
  const MAX_STEP_PERIODS = 3;

  let engines = { paths: [] };
  let unsubscribes = [];
  let enginesFile;
  let writePromise = Promise.resolve();
  let writeDirty = false;
  let writeTimer = null;
  const metaPublished = new Set();

  function writeToPersistentStore(data) {
    // A write of the latest state supersedes any pending debounced write.
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    writeDirty = false;
    const snapshot = JSON.stringify({ engines: data });
    const tmpFile = `${enginesFile}.tmp`;
    writePromise = writePromise
      // Keep the chain alive after a failed write, but don't swallow silently —
      // the failing caller logs its own error; this surfaces stale ones too.
      .catch((err) => app.debug(`Previous write failed: ${err.message}`))
      .then(() => writeFile(tmpFile, snapshot, 'utf-8'))
      .then(() => rename(tmpFile, enginesFile));
    return writePromise;
  }

  function scheduleDebouncedWrite() {
    writeDirty = true;
    if (!writeTimer) {
      writeTimer = setTimeout(() => {
        writeTimer = null;
        if (writeDirty) {
          writeDirty = false;
          writeToPersistentStore(engines).catch((err) =>
            app.debug(`Write error: ${err.message}`),
          );
        }
      }, 5000);
    }
  }

  function flushWrite() {
    if (writeTimer) {
      clearTimeout(writeTimer);
      writeTimer = null;
    }
    if (writeDirty) {
      writeDirty = false;
      return writeToPersistentStore(engines);
    }
    return writePromise;
  }

  function sanitizeNumber(val, fallback) {
    return Number.isFinite(val) && val >= 0 ? val : fallback;
  }

  plugin.start = function start(options) {
    const updateRate = Math.max(1, options.updateRate || 60);
    enginesFile = join(app.getDataDirPath(), 'engines.json');

    function reportData(engine) {
      const matches = engine.path.match(/^propulsion\.([^.]+)\./);
      if (!matches) {
        app.debug(`Cannot extract engine name from path: ${engine.path}`);
        return;
      }
      const engineName = matches[1];
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: { label: plugin.id },
            timestamp: engine.time || new Date().toISOString(),
            values: [
              {
                path: `propulsion.${engineName}.runTime`,
                value: engine.runTime || 0,
              },
              {
                path: `propulsion.${engineName}.runTimeTrip`,
                value: engine.runTimeTrip || 0,
              },
            ],
          },
        ],
      });
      if (!metaPublished.has(engineName)) {
        const runTimeMeta = app.getSelfPath(
          `propulsion.${engineName}.runTime.meta`,
        );
        const runTimeTripMeta = app.getSelfPath(
          `propulsion.${engineName}.runTimeTrip.meta`,
        );
        const metaUpdates = [];
        if (!runTimeMeta || !Object.keys(runTimeMeta).length) {
          metaUpdates.push({
            path: `propulsion.${engineName}.runTime`,
            value: { units: 's' },
          });
        }
        if (!runTimeTripMeta || !Object.keys(runTimeTripMeta).length) {
          metaUpdates.push({
            path: `propulsion.${engineName}.runTimeTrip`,
            value: { units: 's' },
          });
        }
        if (metaUpdates.length) {
          app.handleMessage(plugin.id, {
            context: `vessels.${app.selfId}`,
            updates: [{ meta: metaUpdates }],
          });
        }
        metaPublished.add(engineName);
      }
      setImmediate(() =>
        app.emit('connectionwrite', { providerId: plugin.id }),
      );
    }

    readFile(enginesFile, 'utf-8')
      .then((content) => {
        try {
          const data = JSON.parse(content);
          if (data && data.engines && Array.isArray(data.engines.paths)) {
            engines = {
              paths: data.engines.paths
                // Drop entries whose path doesn't match the propulsion format —
                // an untrusted/corrupt path must not reach GET /hours or the UI.
                .filter((p) => {
                  const ok =
                    typeof p.path === 'string' && VALID_PATH.test(p.path);
                  if (!ok) {
                    app.debug(
                      `Skipping engine with invalid path: ${JSON.stringify(p && p.path)}`,
                    );
                  }
                  return ok;
                })
                .map((p) => ({
                  path: p.path,
                  runTime: sanitizeNumber(p.runTime, 0),
                  runTimeTrip: sanitizeNumber(p.runTimeTrip, 0),
                  running: false, // intentionally non-durable: prevents phantom time accrual across restarts
                  time: p.time || new Date().toISOString(),
                })),
            };
          } else {
            app.debug('Invalid data structure in engines.json');
          }
        } catch (parseError) {
          app.debug(`Error parsing engines.json: ${parseError.message}`);
          return;
        }
        const numberEngines = engines.paths.length;
        app.debug(`Number of engines: ${numberEngines}`);
        app.debug(JSON.stringify(engines.paths));
        engines.paths.forEach((engine) => {
          reportData(engine);
        });
      })
      .catch((error) => {
        if (error.code === 'ENOENT') {
          app.debug('No engines file found, starting fresh');
        } else {
          app.debug(`Error reading engines file: ${error.message}`);
        }
      });

    const subscription = {
      context: 'vessels.self',
      subscribe: [
        {
          path: options.monitorPath
            ? options.monitorPath
            : 'propulsion.*.revolutions',
          period: updateRate * 1000,
        },
      ],
    };

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.debug(`Error: ${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) return;
        delta.updates.forEach((u) => {
          if (!u.values) return;
          u.values.forEach((v) => {
            let engine = engines.paths.find((item) => item.path === v.path);
            let isNew = false;

            if (!engine) {
              app.debug('new engine');
              isNew = true;
              engine = {
                path: v.path,
                runTime: 0,
                runTimeTrip: 0,
                running: false,
              };
              engines.paths.push(engine);
            }

            const previousEngine = { ...engine };

            const tsMs = u.timestamp ? Date.parse(u.timestamp) : NaN;
            const deltaTime = Number.isFinite(tsMs)
              ? new Date(tsMs).toISOString()
              : new Date().toISOString();
            engine.running = v.value > 0 || v.value === 'started';

            if (previousEngine.running && previousEngine.time) {
              const prevMs = Date.parse(previousEngine.time);
              const currMs = Date.parse(deltaTime);
              let elapsedSeconds = 0;
              if (Number.isFinite(prevMs) && Number.isFinite(currMs)) {
                // Clamp the step: drop negative spans (clock skew / out-of-order
                // deltas) and cap forward jumps so a dropped data source or
                // clock step isn't counted as continuous runtime.
                const span = (currMs - prevMs) / 1000;
                elapsedSeconds = Math.min(
                  Math.max(0, span),
                  updateRate * MAX_STEP_PERIODS,
                );
              }
              engine.runTime += elapsedSeconds;
              engine.runTimeTrip += elapsedSeconds;
              app.debug('increment engine hours', {
                elapsedSeconds,
              });
            }

            if (engine.running) {
              engine.time = deltaTime;
            }

            if (
              isNew ||
              previousEngine.running !== engine.running ||
              previousEngine.runTime !== engine.runTime
            ) {
              app.debug('saving');
              scheduleDebouncedWrite();
              reportData(engine);
            }
          });
        });
      },
    );
  };

  plugin.registerWithRouter = (router) => {
    router.get('/hours', (req, res) => {
      res.json(engines);
    });
    router.put('/hours', (req, res) => {
      // Gate writes through the server's security strategy when one is present.
      // On an unsecured server (or in tests) securityStrategy is absent and the
      // request is allowed, matching SignalK's default behaviour.
      if (
        app.securityStrategy &&
        typeof app.securityStrategy.shouldAllowPut === 'function' &&
        !app.securityStrategy.shouldAllowPut(
          req,
          'vessels.self',
          { type: 'plugin', id: plugin.id },
          'propulsion',
        )
      ) {
        res.status(403).send('Permission denied');
        return;
      }
      const newEngines = req.body;
      const paths = newEngines && newEngines.paths;
      if (
        Array.isArray(paths) &&
        paths.length <= MAX_ENGINES &&
        paths.every(
          (p) =>
            p &&
            typeof p.path === 'string' &&
            VALID_PATH.test(p.path) &&
            Number.isFinite(p.runTime) &&
            p.runTime >= 0 &&
            Number.isFinite(p.runTimeTrip) &&
            p.runTimeTrip >= 0,
        ) &&
        new Set(paths.map((p) => p.path)).size === paths.length
      ) {
        engines = {
          paths: newEngines.paths.map((p) => ({
            path: p.path,
            runTime: p.runTime,
            runTimeTrip: p.runTimeTrip,
            running: !!p.running,
            time:
              typeof p.time === 'string' && !Number.isNaN(Date.parse(p.time))
                ? p.time
                : new Date().toISOString(),
          })),
        };
        writeToPersistentStore(engines)
          .then(() => res.status(200).send('OK'))
          .catch((err) => {
            app.debug(`Write error: ${err.message}`);
            res.status(500).send('Failed to save data');
          });
      } else {
        res.status(400).send('Invalid data structure');
      }
    });
  };

  plugin.stop = function stop() {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    const flushed = flushWrite();
    engines = { paths: [] };
    metaPublished.clear();
    writePromise = flushed.catch(() => {});
    return flushed;
  };

  plugin.schema = {
    type: 'object',
    properties: {
      monitorPath: {
        type: 'string',
        default: 'propulsion.*.revolutions',
        title: 'Detect engine running by monitoring:',
        enum: ['propulsion.*.revolutions', 'propulsion.*.state'],
      },
      updateRate: {
        type: 'integer',
        default: 60,
        minimum: 1,
        title:
          'How often engine revolutions/state is monitored. Default value is 60s',
      },
    },
  };

  return plugin;
};
