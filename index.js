const { readFile, writeFile, access } = require('fs/promises');
const { join } = require('path');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours Logger';
  plugin.description = 'Persistent engine hour logger. Log all engines, which report revolutions to SignalK';

  let engines = { paths: [] };
  let unsubscribes = [];
  /* eslint-disable no-unused-vars */
  const setStatus = app.setPluginStatus || app.setProviderStatus;

  plugin.start = function start(options) {
    const enginesFile = join(app.getDataDirPath(), 'engines.json');
    access(enginesFile)
      .then(() => {
        readFile(enginesFile, 'utf-8')
        .then((content) => JSON.parse(content))
        .then((data) => {
          engines = data.engines;
          var numberEngines = Object.keys(engines.paths).length;
          app.debug("Number of engine: " + numberEngines);
          app.debug(engines.paths);
          engines.paths.forEach((engine) => {
            reportData(engine.path, engine.runTime);
          })
        });
      })
      .catch((error) => {});
    
    const subscription = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'propulsion.*.revolutions',
          period: options.updateRate * 1000,
        },
      ],
    };

    function reportData (path, runTime) {
      const matches = path.match(/[^.]+\.(.+)\.[^.]+/);
      const engineName = matches ? matches[1] : null;
      app.handleMessage(plugin.id, {
        context: `vessels.${app.selfId}`,
        updates: [
          {
            source: {
              label: plugin.id,
            },
            timestamp: new Date().toISOString(),
            values: [
              {
                path: `propulsion.${engineName}.runTime`,
                value: runTime,
              },
            ],
          },
        ],
      });
      setImmediate(() =>
        app.emit('connectionwrite', { providerId: plugin.id })
      )
    }

    function writeToPersistentStore (engines) {
      writeFile(enginesFile, JSON.stringify({
        engines,
      }), 'utf-8');
    }

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error: ${subscriptionError}`);
      },
      (delta) => {
        if (!delta.updates) {
          return;
        }
        delta.updates.forEach((u) => {
          if (!u.values) {
            return;
          }
          u.values.forEach((v) => {
            const pathObject = engines.paths.find((item) => item.path === v.path);
            if (!pathObject) {
              engines.paths.push(
                {
                  path: v.path,
                  runTime: 0,
                  time: new Date().toISOString(),
                },
              );
              writeToPersistentStore(engines);
            }
            if (pathObject && v.value > 0) {
              pathObject.runTime += options.updateRate;
              pathObject.time = new Date().toISOString();
              writeToPersistentStore(engines);
            }
            app.debug(engines);
            let runTime = 0
            try {
              runTime = pathObject.runTime;
            } catch (error) {
            }
            reportData(v.path, runTime);
          });
        });
      },
    );
  };

  plugin.stop = function stop() {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
  };

  plugin.schema = {
    type: 'object',
    properties: {
      updateRate: {
        type: 'integer',
        default: 60,
        minimum: 1,
        title: 'How often engine revolutions is monitored. Default value is 60s',
      },
    },
  };

  return plugin;
};
