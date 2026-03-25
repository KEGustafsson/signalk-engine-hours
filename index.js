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
    const tmpFile = enginesFile + '.tmp';
    writePromise = writePromise
      .catch(() => {})
      .then(() => writeFile(tmpFile, JSON.stringify({ engines: data }), 'utf-8'))
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

  plugin.start = function start(options) {
    enginesFile = join(app.getDataDirPath(), 'engines.json');
    readFile(enginesFile, 'utf-8')
      .then((content) => {
        const data = JSON.parse(content);
        if (data && data.engines) {
          engines = data.engines;
        } else {
          app.debug('Invalid data structure in engines.json');
        }
        const numberEngines = engines.paths.length;
        app.debug("Number of engine: " + numberEngines);
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
          period: options.updateRate * 1000,
        }
      ],
    };

    function reportData(path, runTime, runTimeTrip, logTime) {
      const matches = path.match(/[^.]+\.(.+)\.[^.]+/);
      if (!matches) {
        app.debug(`Cannot extract engine name from path: ${path}`);
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
        const runTimeMeta = app.getSelfPath('propulsion.' + engineName + '.runTime.meta');
        const runTimeTripMeta = app.getSelfPath('propulsion.' + engineName + '.runTimeTrip.meta');
        const metaUpdates = [];
        if (!runTimeMeta || !Object.keys(runTimeMeta).length) {
          metaUpdates.push({ path: `propulsion.${engineName}.runTime`, value: { units: "s" } });
        }
        if (!runTimeTripMeta || !Object.keys(runTimeTripMeta).length) {
          metaUpdates.push({ path: `propulsion.${engineName}.runTimeTrip`, value: { units: "s" } });
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
            let pathObject = engines.paths.find((item) => item.path === v.path);
            if (!pathObject) {
              pathObject = {
                path: v.path,
                runTime: 0,
                runTimeTrip: 0,
                time: new Date().toISOString(),
              };
              engines.paths.push(pathObject);
              scheduleDebouncedWrite();
            }
            if (v.value > 0 || v.value === 'started') {
              pathObject.runTime += options.updateRate;
              pathObject.runTimeTrip += options.updateRate;
              pathObject.time = new Date().toISOString();
              scheduleDebouncedWrite();
            }
            app.debug('engines', engines);
            reportData(v.path, pathObject.runTime, pathObject.runTimeTrip, pathObject.time);
          });
        });
      },
    );
  };

  plugin.registerWithRouter = (router) => {
    router.get('/hours', (req, res) => {
      res.contentType('application/json');
      res.send(JSON.stringify(engines));
    });
    router.put('/hours', (req, res) => {
      const newEngines = req.body;
      if (newEngines && Array.isArray(newEngines.paths)
        && newEngines.paths.every((p) => typeof p.path === 'string'
          && typeof p.runTime === 'number'
          && typeof p.runTimeTrip === 'number')) {
        engines = { paths: newEngines.paths.map((p) => ({
          path: p.path,
          runTime: p.runTime,
          runTimeTrip: p.runTimeTrip,
          time: p.time || new Date().toISOString(),
        })) };
        writeToPersistentStore(engines)
          .then(() => res.status(200).send("OK"))
          .catch((err) => {
            app.debug(`Write error: ${err.message}`);
            res.status(500).send("Failed to save data");
          });
      } else {
        res.status(400).send("Invalid data structure");
      }
    });
  };

  plugin.stop = function stop() {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    flushWrite();
    engines = { paths: [] };
    writePromise = Promise.resolve();
    metaPublished.clear();
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
