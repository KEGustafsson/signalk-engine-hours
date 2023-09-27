const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');
const lockfile = require('proper-lockfile');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours';
  plugin.description = 'Tbd';

  let engines = {};
  let state;
  let unsubscribes = [];
  const setStatus = app.setPluginStatus || app.setProviderStatus;

  const retryOptions = {
    retries: {
        retries: 5,
        factor: 3,
        minTimeout: 1 * 1000,
        maxTimeout: 60 * 1000,
        randomize: true,
    }
  };
  
  plugin.start = function start(options) {
    const enginesFile = join(app.getDataDirPath(), 'engines.json');
    readFile(enginesFile, 'utf-8')
      .catch((e) => {
        engines = {
          paths: []
        };
        writeFile(enginesFile, JSON.stringify({
          engines,
        }), 'utf-8')
      });

    const subscription = {
      context: 'vessels.self',
      subscribe: [
        {
          path: 'propulsion.*.revolutions',
          period: options.updateRate * 1000,
        },
      ],
    };

    /*
    function setState(hours) {
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
                path: 'propulsion.engineHours_tests',
                value: hours,
              },
            ],
          },
        ],
      });
      setStatus(`Xxx`);
    }
    */

    app.subscriptionmanager.subscribe(
      subscription,
      unsubscribes,
      (subscriptionError) => {
        app.error(`Error:${subscriptionError}`);
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
            const path = v.path;
            const value = v.value;

            lockfile.lock(enginesFile, retryOptions)
              .then((release) => {
                readFile(enginesFile, 'utf-8')
                  .then((content) => JSON.parse(content))
                  .then((data) => {
                    const pathObject = data.engines.paths.find((item) => item.path === path);
                    if (!pathObject) {
                      data.engines.paths.push(
                        {
                          path: path,
                          state: null,
                          time: new Date().toISOString(),
                        }
                      );
                      const engines = data.engines
                      writeFile(enginesFile, JSON.stringify({
                        engines,
                      }), 'utf-8')
                    }
                    if (pathObject) {
                      pathObject.state = pathObject.state + options.updateRate;
                      pathObject.time = new Date().toISOString();
                      console.log(JSON.stringify(data.engines, null, 2))
                      const engines = data.engines
                      writeFile(enginesFile, JSON.stringify({
                        engines,
                      }), 'utf-8')
                    }
                  })
                  .catch((e) => {
                  });
                return release();
              })
              .catch((e) => {
                console.error(e)
              }); 
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
        default: 1,
        minimum: 1,
        title: 'How often to check whether vessel is under way (in minutes)',
      },
    },
  };

  return plugin;
};
