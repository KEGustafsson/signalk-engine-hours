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
  let tmpDir;
  const defaultOptions = { updateRate: 60, monitorPath: 'propulsion.*.revolutions' };

  function makeDelta(pathStr, value) {
    return {
      updates: [{
        values: [{ path: pathStr, value }],
      }],
    };
  }

  beforeEach(async function () {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sk-engine-test-'));
    deltaCallback = null;

    app = {
      selfId: 'urn:mrn:imo:mmsi:123456789',
      debug: sinon.stub(),
      handleMessage: sinon.stub(),
      emit: sinon.stub(),
      getDataDirPath: () => tmpDir,
      getSelfPath: sinon.stub().returns(null),
      subscriptionmanager: {
        subscribe: sinon.stub().callsFake((subscription, unsubs, errCb, cb) => {
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

    it('should load existing engines from file on start', async function () {
      const existingData = {
        engines: {
          paths: [{
            path: 'propulsion.main.revolutions',
            runTime: 3600,
            runTimeTrip: 1800,
            time: '2024-01-01T00:00:00.000Z',
          }],
        },
      };
      await fs.writeFile(path.join(tmpDir, 'engines.json'), JSON.stringify(existingData));

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
      await fs.writeFile(path.join(tmpDir, 'engines.json'), 'not valid json{{{');

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWithMatch(/Error reading engines file/));
    });

    it('should handle invalid data structure in engines file', async function () {
      await fs.writeFile(path.join(tmpDir, 'engines.json'), JSON.stringify({ foo: 'bar' }));

      plugin.start(defaultOptions);
      await new Promise((r) => setTimeout(r, 100));

      assert.ok(app.debug.calledWith('Invalid data structure in engines.json'));
    });
  });

  describe('delta handling', function () {
    beforeEach(function () {
      plugin.start(defaultOptions);
    });

    it('should register a new engine on first delta', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      assert.ok(app.handleMessage.called);
      const msg = app.handleMessage.getCall(0).args[1];
      const values = msg.updates[0].values;
      assert.equal(values[0].path, 'propulsion.main.runTime');
      assert.equal(values[0].value, 60);
      assert.equal(values[1].path, 'propulsion.main.runTimeTrip');
      assert.equal(values[1].value, 60);
    });

    it('should accumulate time on subsequent deltas', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      deltaCallback(makeDelta('propulsion.main.revolutions', 200));
      deltaCallback(makeDelta('propulsion.main.revolutions', 150));

      // 3 deltas x 60s updateRate = 180s
      const lastCall = app.handleMessage.lastCall.args[1];
      assert.equal(lastCall.updates[0].values[0].value, 180);
      assert.equal(lastCall.updates[0].values[1].value, 180);
    });

    it('should not accumulate time when value is 0 (engine stopped)', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      deltaCallback(makeDelta('propulsion.main.revolutions', 0));

      // First delta: 60s, second delta: engine stopped, still 60s
      const calls = app.handleMessage.getCalls()
        .filter((c) => c.args[1].updates[0].values);
      const lastMsg = calls[calls.length - 1].args[1];
      assert.equal(lastMsg.updates[0].values[0].value, 60);
    });

    it('should handle state-based monitoring (value = "started")', function () {
      plugin.stop();
      plugin.start({ updateRate: 30, monitorPath: 'propulsion.*.state' });

      deltaCallback(makeDelta('propulsion.port.state', 'started'));

      const msg = app.handleMessage.getCall(0).args[1];
      assert.equal(msg.updates[0].values[0].path, 'propulsion.port.runTime');
      assert.equal(msg.updates[0].values[0].value, 30);
    });

    it('should track multiple engines independently', function () {
      deltaCallback(makeDelta('propulsion.port.revolutions', 100));
      deltaCallback(makeDelta('propulsion.starboard.revolutions', 200));
      deltaCallback(makeDelta('propulsion.port.revolutions', 150));

      // port: 2 updates x 60s = 120s
      // starboard: 1 update x 60s = 60s
      const calls = app.handleMessage.getCalls()
        .filter((c) => c.args[1].updates[0].values);

      const portCalls = calls.filter((c) => c.args[1].updates[0].values[0].path === 'propulsion.port.runTime');
      const starboardCalls = calls.filter((c) => c.args[1].updates[0].values[0].path === 'propulsion.starboard.runTime');

      assert.equal(portCalls[portCalls.length - 1].args[1].updates[0].values[0].value, 120);
      assert.equal(starboardCalls[starboardCalls.length - 1].args[1].updates[0].values[0].value, 60);
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
      assert.ok(!app.handleMessage.called);
    });
  });

  describe('meta publication', function () {
    beforeEach(function () {
      plugin.start(defaultOptions);
    });

    it('should publish meta with units on first report', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const metaCalls = app.handleMessage.getCalls()
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

      const metaCalls = app.handleMessage.getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 1);
    });

    it('should publish meta separately for each engine', function () {
      deltaCallback(makeDelta('propulsion.port.revolutions', 100));
      deltaCallback(makeDelta('propulsion.starboard.revolutions', 100));

      const metaCalls = app.handleMessage.getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 2);
    });

    it('should skip meta if already present in SignalK', function () {
      app.getSelfPath
        .withArgs('propulsion.main.runTime.meta').returns({ units: 's' })
        .withArgs('propulsion.main.runTimeTrip.meta').returns({ units: 's' });

      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const metaCalls = app.handleMessage.getCalls()
        .filter((c) => c.args[1].updates[0].meta);
      assert.equal(metaCalls.length, 0);
    });
  });

  describe('persistence', function () {
    it('should write engines to disk after debounce', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      // Force flush
      plugin.stop();
      await new Promise((r) => setTimeout(r, 200));

      const content = await fs.readFile(path.join(tmpDir, 'engines.json'), 'utf-8');
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

    it('should debounce multiple rapid updates into one write', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      deltaCallback(makeDelta('propulsion.main.revolutions', 200));
      deltaCallback(makeDelta('propulsion.main.revolutions', 300));

      // Flush writes and wait for completion
      plugin.stop();
      await new Promise((r) => setTimeout(r, 200));

      // Verify the file has the final accumulated value (3 x 60 = 180),
      // proving all updates were coalesced into one write
      const content = await fs.readFile(path.join(tmpDir, 'engines.json'), 'utf-8');
      const data = JSON.parse(content);
      assert.equal(data.engines.paths[0].runTime, 180);
    });
  });

  describe('REST API', function () {
    let routes;

    beforeEach(function () {
      routes = {};
      const router = {
        get: (path, handler) => { routes[`GET ${path}`] = handler; },
        put: (path, handler) => { routes[`PUT ${path}`] = handler; },
      };
      plugin.start(defaultOptions);
      plugin.registerWithRouter(router);
    });

    it('should register GET and PUT /hours routes', function () {
      assert.ok(routes['GET /hours']);
      assert.ok(routes['PUT /hours']);
    });

    it('GET /hours should return current engines data', function () {
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));

      const res = {
        contentType: sinon.stub(),
        send: sinon.stub(),
      };
      routes['GET /hours']({}, res);

      assert.ok(res.contentType.calledWith('application/json'));
      const data = JSON.parse(res.send.getCall(0).args[0]);
      assert.equal(data.paths.length, 1);
      assert.equal(data.paths[0].runTime, 60);
    });

    it('PUT /hours should update engines with valid data', async function () {
      const req = {
        body: {
          paths: [{
            path: 'propulsion.main.revolutions',
            runTime: 7200,
            runTimeTrip: 3600,
            time: '2024-06-01T00:00:00.000Z',
          }],
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
      const getRes = {
        contentType: sinon.stub(),
        send: sinon.stub(),
      };
      routes['GET /hours']({}, getRes);
      const data = JSON.parse(getRes.send.getCall(0).args[0]);
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

    it('PUT /hours should sanitize input (strip extra properties)', async function () {
      const req = {
        body: {
          paths: [{
            path: 'propulsion.main.revolutions',
            runTime: 100,
            runTimeTrip: 50,
            malicious: '<script>alert("xss")</script>',
          }],
        },
      };
      const res = {
        status: sinon.stub().returnsThis(),
        send: sinon.stub(),
      };
      routes['PUT /hours'](req, res);
      await new Promise((r) => setTimeout(r, 200));

      const getRes = { contentType: sinon.stub(), send: sinon.stub() };
      routes['GET /hours']({}, getRes);
      const data = JSON.parse(getRes.send.getCall(0).args[0]);
      assert.equal(data.paths[0].malicious, undefined);
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
      const routes = {};
      const router = {
        get: (p, handler) => { routes[`GET ${p}`] = handler; },
        put: (p, handler) => { routes[`PUT ${p}`] = handler; },
      };
      plugin.registerWithRouter(router);
      const res = { contentType: sinon.stub(), send: sinon.stub() };
      routes['GET /hours']({}, res);
      const data = JSON.parse(res.send.getCall(0).args[0]);
      assert.equal(data.paths.length, 0);
    });

    it('should flush pending writes before resetting', async function () {
      plugin.start(defaultOptions);
      deltaCallback(makeDelta('propulsion.main.revolutions', 100));
      plugin.stop();

      await new Promise((r) => setTimeout(r, 200));

      const content = await fs.readFile(path.join(tmpDir, 'engines.json'), 'utf-8');
      const data = JSON.parse(content);
      assert.equal(data.engines.paths[0].runTime, 60);
    });
  });
});
