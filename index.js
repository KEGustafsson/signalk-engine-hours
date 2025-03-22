const { readFile, writeFile, access } = require('fs/promises');
const { join } = require('path');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours Logger';
  plugin.description = 'Persistent engine hour logger. Log all engines, which report revolutions to SignalK';

  let engines = { paths: [] };
  let unsubscribes = [];
  const setStatus = app.setPluginStatus || app.setProviderStatus;
  let enginesFile;

  function writeToPersistentStore(engines) {
    return writeFile(enginesFile, JSON.stringify({ engines }), 'utf-8');
  }

  plugin.start = function start(options) {
    enginesFile = join(app.getDataDirPath(), 'engines.json');
    access(enginesFile)
      .then(() => {
        return readFile(enginesFile, 'utf-8');
      })
      .then((content) => {
        const data = JSON.parse(content);
        if (data && data.engines) {
          engines = data.engines;
        } else {
          app.error('Invalid data structure in engines.json');
        }
        const numberEngines = Object.keys(engines.paths).length;
        app.debug("Number of engine: " + numberEngines);
        app.debug(engines.paths);
        engines.paths.forEach((engine) => {
          reportData(engine.path, engine.runTime, engine.runTimeTrip, engine.time);
        });
      })
      .catch((error) => {
        app.error(`Error accessing engines file: ${error.message}`);
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
      const engineName = matches ? matches[1] : null;
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
      if (!Object.keys(app.getSelfPath('propulsion.' + engineName + '.runTimeTrip.meta')).length) {
        app.handleMessage(plugin.id, {
          context: `vessels.${app.selfId}`,
          updates: [
            {
              meta: [
                {
                  path: `propulsion.${engineName}.runTimeTrip`,
                  value: { units: "s" },
                },
              ],
            },
          ],
        });
      }
      setImmediate(() => app.emit('connectionwrite', { providerId: plugin.id }));
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error: ${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) return;
        delta.updates.forEach((u) => {
          if (!u.values) return;
          u.values.forEach((v) => {
            const pathObject = engines.paths.find((item) => item.path === v.path);
            if (!pathObject) {
              engines.paths.push({
                path: v.path,
                runTime: 0,
                runTimeTrip: 0,
                time: new Date().toISOString(),
              });
              writeToPersistentStore(engines);
            }
            if (pathObject && (v.value > 0 || v.value === 'started')) {
              pathObject.runTime += options.updateRate;
              pathObject.runTimeTrip += options.updateRate;
              pathObject.time = new Date().toISOString();
              writeToPersistentStore(engines);
            }
            app.debug('engines',engines);
            let runTime = 0
            let runTimeTrip = 0
            let logTime = 0
            try {
              runTime = pathObject.runTime;
            } catch (error) {
            }
            try {
              runTimeTrip = pathObject.runTimeTrip;
            } catch (error) {
            }
            try {
              logTime = pathObject.time;
            } catch (error) {
            }
            reportData(v.path, runTime, runTimeTrip, logTime);
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
      if (newEngines && newEngines.paths) {
        engines = newEngines;
        writeToPersistentStore(engines);
        res.status(200).send("OK");
      } else {
        res.status(400).send("Invalid data structure");
      }
    });
  };

  plugin.stop = function stop() {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
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
