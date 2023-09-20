const { readFile, writeFile } = require('fs/promises');
const { join } = require('path');

module.exports = function createPlugin(app) {
  const plugin = {};
  plugin.id = 'signalk-engine-hours';
  plugin.name = 'SignalK Engine Hours';
  plugin.description = 'Tbd';

  let engines = { paths: [] };
  let unsubscribes = [];
  const setStatus = app.setPluginStatus || app.setProviderStatus;
  
  plugin.start = function start(options) {
    const enginesFile = join(app.getDataDirPath(), 'engines.json');

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
            //console.log(v.path);
            //console.log(v.value);
            const path = v.path;
            const value = v.value;

            //Write list of engine paths seen before
            const enginesFile = join(app.getDataDirPath(), 'engines.json');
            readFile(enginesFile, 'utf-8')
              .then((content) => JSON.parse(content))
              .then((data) => {
                if (!(data.engines.paths.find((item) => item.path === path))) { 
                  engines.paths.push({path: path});
                  writeFile(enginesFile, JSON.stringify({
                    engines,
                  }), 'utf-8')
                }
              })
              .catch((e) => {
                engines = {
                  paths: []
                };
                writeFile(enginesFile, JSON.stringify({
                  engines,
                }), 'utf-8')
              }); 

            //Update persistent hours log data to disk
            const stateFile = join(app.getDataDirPath(), path + '.json');
            readFile(stateFile, 'utf-8')
              .then((content) => JSON.parse(content))
              .then((data) => {
                const state = options.updateRate + data.state
                writeFile(stateFile, JSON.stringify({
                  state,
                  time: new Date().toISOString(),
                }), 'utf-8')
                app.debug(path)           
                app.debug(data)           
              })
              .catch((e) => {
                engines = {
                  paths: []
                };
                writeFile(enginesFile, JSON.stringify({
                  engines,
                }), 'utf-8')
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