const { readFile, writeFile, rename } = require('fs/promises');
const { join } = require('path');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours Logger';
  plugin.description = 'Persistent engine hour logger. Log all engines, which report revolutions to SignalK';

  let engines = { paths: [] };
  let unsubscribes = [];
  let enginesFile;
  let writePromise = Promise.resolve();
  let writeDirty = false;
  let writeTimer = null;
  const metaPublished = new Set();

  function writeToPersistentStore(data) {
    const snapshot = JSON.stringify({ engines: data });
    const tmpFile = `${enginesFile}.tmp`;
    writePromise = writePromise
      .catch(() => {})
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
          writeToPersistentStore(engines).catch((err) => app.debug(`Write error: ${err.message}`));
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
    const updateRate = options.updateRate || 60;
    enginesFile = join(app.getDataDirPath(), 'engines.json');

    function reportData(skPath, runTime, runTimeTrip, logTime) {
      const matches = skPath.match(/^propulsion\.([^.]+)\./);
      if (!matches) {
        app.debug(`Cannot extract engine name from path: ${skPath}`);
        return;
      }
      const engineName = matches[1];
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: { label: plugin.id },
            timestamp: logTime || new Date().toISOString(),
            values: [
              { path: `propulsion.${engineName}.runTime`, value: runTime || 0 },
              { path: `propulsion.${engineName}.runTimeTrip`, value: runTimeTrip || 0 },
            ],
          },
        ],
      });
      if (!metaPublished.has(engineName)) {
        const runTimeMeta = app.getSelfPath(`propulsion.${engineName}.runTime.meta`);
        const runTimeTripMeta = app.getSelfPath(`propulsion.${engineName}.runTimeTrip.meta`);
        const metaUpdates = [];
        if (!runTimeMeta || !Object.keys(runTimeMeta).length) {
          metaUpdates.push({ path: `propulsion.${engineName}.runTime`, value: { units: 's' } });
        }
        if (!runTimeTripMeta || !Object.keys(runTimeTripMeta).length) {
          metaUpdates.push({ path: `propulsion.${engineName}.runTimeTrip`, value: { units: 's' } });
        }
        if (metaUpdates.length) {
          app.handleMessage(plugin.id, {
            context: `vessels.${app.selfId}`,
            updates: [{ meta: metaUpdates }],
          });
        }
        metaPublished.add(engineName);
      }
      setImmediate(() => app.emit('connectionwrite', { providerId: plugin.id }));
    }

    readFile(enginesFile, 'utf-8')
      .then((content) => {
        try {
          const data = JSON.parse(content);
          if (data && data.engines && Array.isArray(data.engines.paths)) {
            engines = {
              paths: data.engines.paths.map((p) => ({
                path: typeof p.path === 'string' ? p.path : '',
                runTime: sanitizeNumber(p.runTime, 0),
                runTimeTrip: sanitizeNumber(p.runTimeTrip, 0),
                running: p.running || false,
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
        app.debug(engines.paths);
        engines.paths.forEach((engine) => {
          reportData(engine.path, engine.runTime, engine.runTimeTrip, engine.time);
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
          path: options.monitorPath ? options.monitorPath : 'propulsion.*.revolutions',
          period: updateRate * 1000,
          policy: 'fixed',
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
            const running = v.value > 0 || v.value === 'started';
            const now = new Date();

            // new engine
            if (!engine) {
              app.debug('new engine');
              engine = {
                path: v.path,
                runTime: 0,
                runTimeTrip: 0,
                running,
              };
              engines.paths.push(engine);
            }

            // stopped > stopped
            //    do nothing
            else if (!engine.running && !running) {
              app.debug('stopped - so doing nothing');
              return;
            }

            // stopped > running
            //    record running = T
            else if (!engine.running && running) {
              app.debug('started');
              engine.running = true;
            }

            // running > running
            //    record ++hours
            else if (engine.running && running) {
              app.debug('running');
              const ellapsed = (now - new Date(engine.time)) / 1000;
              engine.runTime += ellapsed;
              engine.runTimeTrip += ellapsed;
            }

            // running > stopped
            //    record running = F
            else if (engine.running && !running) {
              app.debug('stopping');
              engine.running = false;
            }

            engine.time = now.toISOString();
            scheduleDebouncedWrite();
            reportData(v.path, engine.runTime, engine.runTimeTrip, engine.time);
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
      const newEngines = req.body;
      if (newEngines && Array.isArray(newEngines.paths)
        && newEngines.paths.every((p) => typeof p.path === 'string'
          && /^propulsion\.[a-zA-Z0-9_-]+\./.test(p.path)
          && Number.isFinite(p.runTime) && p.runTime >= 0
          && Number.isFinite(p.runTimeTrip) && p.runTimeTrip >= 0)) {
        engines = {
          paths: newEngines.paths.map((p) => ({
            path: p.path,
            runTime: p.runTime,
            runTimeTrip: p.runTimeTrip,
            running: p.running,
            time: (typeof p.time === 'string' && !Number.isNaN(Date.parse(p.time)))
              ? p.time : new Date().toISOString(),
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
    writePromise = Promise.resolve();
    metaPublished.clear();
    return flushed;
  };

  plugin.schema = {
    type: 'object',
    properties: {
      monitorPath: {
        type: 'string',
        default: 'propulsion.*.revolutions',
        title: 'Detect engine running by monitoring:',
        enum: [
          'propulsion.*.revolutions',
          'propulsion.*.state',
        ],
      },
      updateRate: {
        type: 'integer',
        default: 60,
        minimum: 1,
        title: 'How often engine revolutions/state is monitored. Default value is 60s',
      },
    },
  };

  return plugin;
};
