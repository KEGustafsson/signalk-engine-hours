const { strict: assert } = require('assert');
const sinon = require('sinon');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const createPlugin = require('../index');

describe('signalk-engine-hours plugin', function () {
  let app;
  let plugin;
  let deltaCallback;
  let errorCallback;
  let tmpDir;
  const defaultOptions = {
    updateRate: 60,
    monitorPath: 'propulsion.*.revolutions',
  };

  const BASE_TIME = '2024-06-01T00:00:00.000Z';
  const baseMs = Date.parse(BASE_TIME);

  function ts(offsetSec) {
    return new Date(baseMs + offsetSec * 1000).toISOString();
  }

  function makeDelta(pathStr, value, timestamp) {
    return {
      updates: [
        {
          timestamp: timestamp || new Date().toISOString(),
          values: [{ path: pathStr, value }],
        },
      ],
    };
  }

  beforeEach(async function () {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-engine-test-'));
    deltaCallback = null;
    errorCallback = null;

    app = {
      selfId: 'urn:mrn:imo:mmsi:123456789',
      debug: sinon.stub(),
      handleMessage: sinon.stub(),
      emit: sinon.stub(),
      getDataDirPath: () => tmpDir,
      getSelfPath: sinon.stub().returns(null),
      subscriptionmanager: {
        subscribe: sinon.stub().callsFake((subscription, unsubs, errCb, cb) => {
          errorCallback = errCb;
          deltaCallback = cb;
          unsubs.push(sinon.stub());
        }),
      },
    };

    plugin = createPlugin(app);
  });

  afterEach(async function () {
    if (plugin) {
      plugin.stop();
    }
    // Allow pending async ops to settle
    await new Promise((r) => setTimeout(r, 50));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('plugin metadata', function () {
    it('should have correct id, name, and description', function () {
      assert.equal(plugin.id, 'signalk-engine-hours');
      assert.equal(plugin.name, 'SignalK Engine Hours Logger');
      assert.ok(plugin.description.length > 0);
    });

    it('should have a valid schema with monitorPath and updateRate', function () {
      assert.equal(plugin.schema.type, 'object');
      assert.ok(plugin.schema.properties.monitorPath);
      assert.ok(plugin.schema.properties.updateRate);
      assert.deepEqual(plugin.schema.properties.monitorPath.enum, [
        'propulsion.*.revolutions',
        'propulsion.*.state',
      ]);
      assert.equal(plugin.schema.properties.updateRate.default, 60);
      assert.equal(plugin.schema.properties.updateRate.minimum, 1);
    });
  });

  describe('plugin.start', function () {
    it('should subscribe to the correct path and period', function () {
      plugin.start(defaultOptions);
      const call = app.subscriptionmanager.subscribe.getCall(0);
      const subscription = call.args[0];
      assert.equal(subscription.context, 'vessels.self');
      assert.equal(subscription.subscribe[0].path, 'propulsion.*.revolutions');
      assert.equal(subscription.subscribe[0].period, 60000);
    });

    it('should use custom monitorPath from options', function () {
      plugin.start({ updateRate: 60, monitorPath: 'propulsion.*.state' });
      const call = app.subscriptionmanager.subscribe.getCall(0);
      assert.equal(call.args[0].subscribe[0].path, 'propulsion.*.state');
    });

    it('should default updateRate to 60 when not provided', function () {
      plugin.start({ monitorPath: 'propulsion.*.revolutions' });
      const call = app.subscriptionmanager.subscribe.getCall(0);
      assert.equal(call.args[0].subscribe[0].period, 60000);

      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));
      const msg = app.handleMessage.lastCall.args[1];
      assert.equal(msg.updates[0].values[0].value, 60);
    });

    it('should load existing engines from file on start', async function () {
      const existingData = {
        engines: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 3600,
              runTimeTrip: 1800,
              time: '2024-01-01T00:00:00.000Z',
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        JSON.stringify(existingData),
      );

      plugin.start(defaultOptions);
      // Wait for async file read
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.handleMessage.called);
      const msg = app.handleMessage.getCall(0).args[1];
      assert.equal(msg.updates[0].values[0].value, 3600);
      assert.equal(msg.updates[0].values[1].value, 1800);
    });

    it('should handle missing engines file gracefully', async function () {
      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWith('No engines file found, starting fresh'));
    });

    it('should handle corrupted JSON in engines file', async function () {
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        'not valid json{{{',
      );

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWithMatch(/Error parsing engines.json/));
    });

    it('should handle invalid data structure in engines file', async function () {
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        JSON.stringify({ foo: 'bar' }),
      );

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWith('Invalid data structure in engines.json'));
    });

    it('should handle engines file with non-array paths', async function () {
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        JSON.stringify({ engines: { paths: 'not-array' } }),
      );

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWith('Invalid data structure in engines.json'));
    });

    it('should handle engines file with empty paths array', async function () {
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        JSON.stringify({ engines: { paths: [] } }),
      );

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWith('Number of engines: 0'));
      assert.ok(!app.handleMessage.called);
    });

    it('should sanitize NaN/negative values loaded from file', async function () {
      const badData = {
        engines: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: NaN,
              runTimeTrip: -100,
              time: '2024-01-01T00:00:00.000Z',
            },
          ],
        },
      };
      await fs.writeFile(
        path.join(tmpDir, 'engines.json'),
        JSON.stringify(badData),
      );

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      const msg = app.handleMessage.getCall(0).args[1];
      assert.equal(msg.updates[0].values[0].value, 0);
      assert.equal(msg.updates[0].values[1].value, 0);
    });
  });

  describe('delta handling', function () {
    beforeEach(function () {
      plugin.start(defaultOptions);
    });

    it('should register a new engine on first delta without accruing time', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));

      assert.ok(app.handleMessage.called);
      const msg = app.handleMessage.getCall(0).args[1];
      const values = msg.updates[0].values;
      assert.equal(values[0].path, 'propulsion.main.runTime');
      assert.equal(values[0].value, 0);
      assert.equal(values[1].path, 'propulsion.main.runTimeTrip');
      assert.equal(values[1].value, 0);
    });

    it('should accumulate time on subsequent deltas', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 200, ts(60)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 150, ts(120)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 150, ts(180)));

      // 4 deltas spaced 60s apart -> 3 spans of 60s = 180s
      const lastCall = app.handleMessage.lastCall.args[1];
      assert.equal(lastCall.updates[0].values[0].value, 180);
      assert.equal(lastCall.updates[0].values[1].value, 180);
    });

    it('should not accumulate time when value is 0 (engine stopped)', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(120)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 0, ts(180)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 0, ts(240)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 0, ts(300)));

      // Spans where prev was running: 0->60, 60->120, 120->180 (engine stops at end)
      // = 3 * 60 = 180s. Spans 180->240 and 240->300 do not accrue (prev !running).
      const calls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);
      const lastMsg = calls[calls.length - 1].args[1];
      assert.equal(lastMsg.updates[0].values[0].value, 180);
    });

    it('should still report data when value is 0 (just no accumulation)', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 0, ts(0)));

      const calls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].args[1].updates[0].values[0].value, 0);
    });

    it('should not accumulate time for non-"started" state values', function () {
      plugin.stop();
      plugin.start({ updateRate: 30, monitorPath: 'propulsion.*.state' });

      deltaCallback(makeDelta('propulsion.port.state', 'started', ts(0)));
      deltaCallback(makeDelta('propulsion.port.state', 'started', ts(30)));
      deltaCallback(makeDelta('propulsion.port.state', 'stopped', ts(60)));
      deltaCallback(makeDelta('propulsion.port.state', 'standby', ts(90)));

      const calls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);
      const lastMsg = calls[calls.length - 1].args[1];
      // started->started: 30s accrue, started->stopped: 30s accrue, stopped->standby: no accrue
      assert.equal(lastMsg.updates[0].values[0].value, 60);
    });

    it('should handle state-based monitoring (value = "started")', function () {
      plugin.stop();
      plugin.start({ updateRate: 30, monitorPath: 'propulsion.*.state' });

      deltaCallback(makeDelta('propulsion.port.state', 'started', ts(0)));
      deltaCallback(makeDelta('propulsion.port.state', 'started', ts(30)));

      const msg = app.handleMessage.lastCall.args[1];
      assert.equal(msg.updates[0].values[0].path, 'propulsion.port.runTime');
      assert.equal(msg.updates[0].values[0].value, 30);
    });

    it('should not accumulate time for negative values', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));
      deltaCallback(makeDelta('propulsion.main.revolutions', -50, ts(120)));
      deltaCallback(makeDelta('propulsion.main.revolutions', -50, ts(180)));
      deltaCallback(makeDelta('propulsion.main.revolutions', -50, ts(240)));

      // Spans where prev was running: 0->60, 60->120 (engine becomes !running at -50)
      // = 2 * 60 = 120s. Spans 120->180, 180->240 do not accrue (prev !running).
      const calls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);
      const lastMsg = calls[calls.length - 1].args[1];
      assert.equal(lastMsg.updates[0].values[0].value, 120);
    });

    it('should track multiple engines independently', function () {
      deltaCallback(makeDelta('propulsion.port.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.starboard.revolutions', 200, ts(0)));
      deltaCallback(makeDelta('propulsion.port.revolutions', 150, ts(60)));
      deltaCallback(makeDelta('propulsion.starboard.revolutions', 250, ts(60)));
      deltaCallback(makeDelta('propulsion.port.revolutions', 200, ts(120)));

      // port: 3 deltas, 2 spans -> 120s
      // starboard: 2 deltas, 1 span -> 60s
      const calls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);

      const portCalls = calls.filter(
        (c) =>
          c.args[1].updates[0].values[0].path === 'propulsion.port.runTime',
      );
      const starboardCalls = calls.filter(
        (c) =>
          c.args[1].updates[0].values[0].path ===
          'propulsion.starboard.runTime',
      );

      assert.equal(
        portCalls[portCalls.length - 1].args[1].updates[0].values[0].value,
        120,
      );
      assert.equal(
        starboardCalls[starboardCalls.length - 1].args[1].updates[0].values[0]
          .value,
        60,
      );
    });

    it('should skip deltas with no updates', function () {
      deltaCallback({});
      deltaCallback({ updates: null });
      assert.ok(!app.handleMessage.called);
    });

    it('should skip updates with no values', function () {
      deltaCallback({ updates: [{}] });
      deltaCallback({ updates: [{ values: null }] });
      assert.ok(!app.handleMessage.called);
    });

    it('should skip paths that cannot be parsed for engine name', function () {
      deltaCallback(makeDelta('invalidpath', 100));

      assert.ok(app.debug.calledWithMatch(/Cannot extract engine name/));
      // handleMessage should not be called for data (meta check won't happen either)
      const dataCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].values);
      assert.equal(dataCalls.length, 0);
    });

    it('should emit connectionwrite via setImmediate after reporting', function (done) {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      // connectionwrite is emitted via setImmediate, so check on next tick
      setImmediate(() => {
        assert.ok(
          app.emit.calledWith('connectionwrite', { providerId: plugin.id }),
        );
        done();
      });
    });
  });

  describe('subscription error handling', function () {
    it('should log subscription errors via debug', function () {
      plugin.start(defaultOptions);
      errorCallback('test subscription error');

      assert.ok(app.debug.calledWith('Error: test subscription error'));
    });
  });

  describe('meta publication', function () {
    beforeEach(function () {
      plugin.start(defaultOptions);
    });

    it('should publish meta with units on first report', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const metaCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 1);

      const meta = metaCalls[0].args[1].updates[0].meta;
      assert.equal(meta.length, 2);
      assert.equal(meta[0].path, 'propulsion.main.runTime');
      assert.deepEqual(meta[0].value, { units: 's' });
      assert.equal(meta[1].path, 'propulsion.main.runTimeTrip');
      assert.deepEqual(meta[1].value, { units: 's' });
    });

    it('should not publish meta again for same engine', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      deltaCallback(makeDelta('propulsion.main.revolutions', 200));

      const metaCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 1);
    });

    it('should publish meta separately for each engine', function () {
      deltaCallback(makeDelta('propulsion.port.revolutions', 100));
      deltaCallback(makeDelta('propulsion.starboard.revolutions', 100));

      const metaCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 2);
    });

    it('should skip meta if already present in SignalK', function () {
      app.getSelfPath
        .withArgs('propulsion.main.runTime.meta')
        .returns({ units: 's' })
        .withArgs('propulsion.main.runTimeTrip.meta')
        .returns({ units: 's' });

      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const metaCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 0);
    });
  });

  describe('persistence', function () {
    it('should write engines to disk after debounce', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));

      // Force flush
      plugin.stop();
      await new Promise((r) => setTimeout(r, 200));

      const content = await fs.readFile(
        path.join(tmpDir, 'engines.json'),
        'utf-8',
      );
      const data = JSON.parse(content);
      assert.ok(data.engines);
      assert.ok(data.engines.paths);
      assert.equal(data.engines.paths.length, 1);
      assert.equal(data.engines.paths[0].path, 'propulsion.main.revolutions');
      assert.equal(data.engines.paths[0].runTime, 60);
    });

    it('should not leave temp files after write', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      plugin.stop();
      await new Promise((r) => setTimeout(r, 200));

      const files = await fs.readdir(tmpDir);
      assert.ok(!files.includes('engines.json.tmp'));
      assert.ok(files.includes('engines.json'));
    });

    it('should not accrue time across a restart when engine was running', async function () {
      // Engine is running at stop time; saved with running:true in file.
      // On reload, running must be reset to false so the gap between
      // plugin stop and restart does not inflate the counter.
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));

      // Stop while engine is still "running" — persists running:true
      await plugin.stop();

      // Manually patch the saved file to set running:true (as the old code would have done)
      const filePath = path.join(tmpDir, 'engines.json');
      const saved = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      saved.engines.paths[0].running = true;
      // Simulate 1 hour of server downtime by backdating the saved timestamp
      saved.engines.paths[0].time = ts(-3600);
      await fs.writeFile(filePath, JSON.stringify(saved));

      // Restart plugin
      plugin = createPlugin(app);
      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      // First delta after restart — must NOT add 3600s of phantom time
      app.handleMessage.resetHistory();
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(3660)));

      const msg = app.handleMessage.lastCall.args[1];
      const runTime = msg.updates[0].values[0].value;
      // Should still be ~60s (from before restart), not 3660s+
      assert.ok(runTime <= 60, `Expected runTime <= 60 but got ${runTime}`);
    });

    it('should debounce multiple rapid updates into one write', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 200, ts(60)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 300, ts(120)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 300, ts(180)));

      // Flush writes and wait for completion
      plugin.stop();
      await new Promise((r) => setTimeout(r, 200));

      // Verify the file has the final accumulated value (3 spans x 60s = 180s),
      // proving all updates were coalesced into one write
      const content = await fs.readFile(
        path.join(tmpDir, 'engines.json'),
        'utf-8',
      );
      const data = JSON.parse(content);
      assert.equal(data.engines.paths[0].runTime, 180);
    });
  });

  describe('REST API', function () {
    let routes;

    beforeEach(function () {
      routes = {};
      const router = {
        get: (p, handler) => {
          routes[`GET ${p}`] = handler;
        },
        put: (p, handler) => {
          routes[`PUT ${p}`] = handler;
        },
      };
      plugin.start(defaultOptions);
      plugin.registerWithRouter(router);
    });

    it('should register GET and PUT /hours routes', function () {
      assert.ok(routes['GET /hours']);
      assert.ok(routes['PUT /hours']);
    });

    it('GET /hours should return current engines data', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));

      const res = {
        json: sinon.stub(),
      };
      routes['GET /hours']({}, res);

      assert.ok(res.json.called);
      const data = res.json.getCall(0).args[0];
      assert.equal(data.paths.length, 1);
      assert.equal(data.paths[0].runTime, 60);
    });

    it('PUT /hours should update engines with valid data', async function () {
      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 7200,
              runTimeTrip: 3600,
              time: '2024-06-01T00:00:00.000Z',
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };

      routes['PUT /hours'](req, res);
      await new Promise((r) => setTimeout(r, 200));

      assert.ok(res.status.calledWith(200));
      assert.ok(res.send.calledWith('OK'));

      // Verify GET returns updated data
      const getRes = { json: sinon.stub() };
      routes['GET /hours']({}, getRes);
      const data = getRes.json.getCall(0).args[0];
      assert.equal(data.paths[0].runTime, 7200);
    });

    it('PUT /hours should reject invalid data (missing paths)', function () {
      const req = { body: { foo: 'bar' } };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject non-array paths', function () {
      const req = { body: { paths: 'not-an-array' } };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject paths with wrong types', function () {
      const req = {
        body: {
          paths: [{ path: 123, runTime: 'not-a-number', runTimeTrip: 0 }],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject NaN values', function () {
      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: NaN,
              runTimeTrip: 0,
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject negative values', function () {
      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: -100,
              runTimeTrip: 0,
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject invalid path format', function () {
      const req = {
        body: {
          paths: [{ path: '../../etc/passwd', runTime: 100, runTimeTrip: 0 }],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      assert.ok(res.status.calledWith(400));
    });

    it('PUT /hours should reject invalid time string', async function () {
      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 100,
              runTimeTrip: 50,
              time: 'not-a-date',
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      await new Promise((r) => setTimeout(r, 200));

      // Should still accept but replace with valid ISO timestamp
      assert.ok(res.status.calledWith(200));
      const getRes = { json: sinon.stub() };
      routes['GET /hours']({}, getRes);
      const data = getRes.json.getCall(0).args[0];
      assert.ok(!Number.isNaN(Date.parse(data.paths[0].time)));
    });

    it('PUT /hours should sanitize input (strip extra properties)', async function () {
      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 100,
              runTimeTrip: 50,
              malicious: '<script>alert("xss")</script>',
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      await new Promise((r) => setTimeout(r, 200));

      const getRes = { json: sinon.stub() };
      routes['GET /hours']({}, getRes);
      const data = getRes.json.getCall(0).args[0];
      assert.equal(data.paths[0].malicious, undefined);
    });

    it('PUT /hours should respond 500 on write failure', async function () {
      // Make the write fail by removing the temp directory
      await fs.rm(tmpDir, { recursive: true, force: true });

      const req = {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 100,
              runTimeTrip: 50,
            },
          ],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      await new Promise((r) => setTimeout(r, 300));

      assert.ok(res.status.calledWith(500));
      assert.ok(res.send.calledWith('Failed to save data'));

      // Recreate tmpDir so afterEach cleanup works
      await fs.mkdir(tmpDir, { recursive: true });
    });
  });

  describe('plugin.stop', function () {
    it('should unsubscribe all subscriptions', function () {
      plugin.start(defaultOptions);
      const unsub = app.subscriptionmanager.subscribe.getCall(0).args[1][0];
      plugin.stop();
      assert.ok(unsub.called);
    });

    it('should reset engines to empty state', function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      plugin.stop();

      // GET /hours after stop should return empty
      const localRoutes = {};
      const router = {
        get: (p, handler) => {
          localRoutes[`GET ${p}`] = handler;
        },
        put: (p, handler) => {
          localRoutes[`PUT ${p}`] = handler;
        },
      };
      plugin.registerWithRouter(router);
      const res = { json: sinon.stub() };
      localRoutes['GET /hours']({}, res);
      const data = res.json.getCall(0).args[0];
      assert.equal(data.paths.length, 0);
    });

    it('should flush pending writes before resetting', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
      deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));
      const flushed = plugin.stop();
      await flushed;

      const content = await fs.readFile(
        path.join(tmpDir, 'engines.json'),
        'utf-8',
      );
      const data = JSON.parse(content);
      assert.equal(data.engines.paths[0].runTime, 60);
    });

    it('should clear meta cache so meta is re-published on restart', function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      plugin.stop();

      // Restart
      plugin.start(defaultOptions);
      app.handleMessage.resetHistory();
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const metaCalls = app.handleMessage
        .getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 1);
    });

    it('should return a promise from stop', function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      const result = plugin.stop();
      assert.ok(result && typeof result.then === 'function');
    });
  });

  describe('code review regression fixes', function () {
    let routes;

    function registerRoutes() {
      routes = {};
      plugin.registerWithRouter({
        get: (p, handler) => {
          routes[`GET ${p}`] = handler;
        },
        put: (p, handler) => {
          routes[`PUT ${p}`] = handler;
        },
      });
    }

    function getEngines() {
      const res = { json: sinon.stub() };
      routes['GET /hours']({}, res);
      return res.json.getCall(0).args[0];
    }

    function validPutReq() {
      return {
        body: {
          paths: [
            {
              path: 'propulsion.main.revolutions',
              runTime: 100,
              runTimeTrip: 0,
            },
          ],
        },
      };
    }

    describe('accrual clamping', function () {
      beforeEach(function () {
        // updateRate 60 -> max step is 3 sampling periods = 180s
        plugin.start(defaultOptions);
        registerRoutes();
      });

      it('caps a long data gap so a dropout is not counted as runtime', function () {
        deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
        deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(3600)));
        // A 1-hour gap while "running" must clamp to 180s, not 3600s.
        assert.equal(getEngines().paths[0].runTime, 180);
      });

      it('never accrues negative time on a backward timestamp', function () {
        deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(0)));
        deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(60)));
        deltaCallback(makeDelta('propulsion.main.revolutions', 100, ts(30)));
        // Backward step contributes 0, not a negative span.
        assert.equal(getEngines().paths[0].runTime, 60);
      });
    });

    describe('file load validation', function () {
      it('drops engines whose path is not a valid propulsion path', async function () {
        const existingData = {
          engines: {
            paths: [
              {
                path: 'propulsion.main.revolutions',
                runTime: 3600,
                runTimeTrip: 0,
                time: BASE_TIME,
              },
              {
                path: '<img src=x onerror=alert(1)>',
                runTime: 100,
                runTimeTrip: 0,
                time: BASE_TIME,
              },
              { path: 123, runTime: 100, runTimeTrip: 0, time: BASE_TIME },
            ],
          },
        };
        await fs.writeFile(
          path.join(tmpDir, 'engines.json'),
          JSON.stringify(existingData),
        );

        plugin.start(defaultOptions);
        await new Promise((r) => setTimeout(r, 100));
        registerRoutes();

        const data = getEngines();
        assert.equal(data.paths.length, 1);
        assert.equal(data.paths[0].path, 'propulsion.main.revolutions');
      });
    });

    describe('PUT /hours authorization', function () {
      beforeEach(function () {
        plugin.start(defaultOptions);
        registerRoutes();
      });

      it('returns 403 when the security strategy denies the write', function () {
        app.securityStrategy = { shouldAllowPut: sinon.stub().returns(false) };
        const res = {
          status: sinon.stub().returnsThis(),
          send: sinon.stub(),
        };
        routes['PUT /hours'](validPutReq(), res);
        assert.ok(app.securityStrategy.shouldAllowPut.called);
        assert.ok(res.status.calledWith(403));
      });

      it('allows the write when the security strategy permits it', async function () {
        app.securityStrategy = { shouldAllowPut: sinon.stub().returns(true) };
        const res = {
          status: sinon.stub().returnsThis(),
          send: sinon.stub(),
        };
        routes['PUT /hours'](validPutReq(), res);
        await new Promise((r) => setTimeout(r, 200));
        assert.ok(res.status.calledWith(200));
      });
    });

    describe('PUT /hours payload limits', function () {
      beforeEach(function () {
        plugin.start(defaultOptions);
        registerRoutes();
      });

      it('rejects more than the maximum number of engines', function () {
        const paths = [];
        for (let i = 0; i < 65; i += 1) {
          paths.push({
            path: `propulsion.e${i}.revolutions`,
            runTime: 0,
            runTimeTrip: 0,
          });
        }
        const res = {
          status: sinon.stub().returnsThis(),
          send: sinon.stub(),
        };
        routes['PUT /hours']({ body: { paths } }, res);
        assert.ok(res.status.calledWith(400));
      });

      it('rejects duplicate paths', function () {
        const req = {
          body: {
            paths: [
              {
                path: 'propulsion.main.revolutions',
                runTime: 0,
                runTimeTrip: 0,
              },
              {
                path: 'propulsion.main.revolutions',
                runTime: 1,
                runTimeTrip: 0,
              },
            ],
          },
        };
        const res = {
          status: sinon.stub().returnsThis(),
          send: sinon.stub(),
        };
        routes['PUT /hours'](req, res);
        assert.ok(res.status.calledWith(400));
      });
    });
  });
});
