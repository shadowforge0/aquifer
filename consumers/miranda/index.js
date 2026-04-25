'use strict';

const ADAPTER_PACKAGE = '@mingko/aquifer-miranda-adapter';

function loadAdapter() {
  try {
    return require(ADAPTER_PACKAGE);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message || '').includes(ADAPTER_PACKAGE)) {
      throw new Error(
        'Aquifer no longer ships the Miranda persona implementation. ' +
        `Install/use ${ADAPTER_PACKAGE} for Miranda deployments, or compose a generic persona with ` +
        '@shadowforge0/aquifer-memory/consumers/default.'
      );
    }
    throw err;
  }
}

function delegate(name) {
  return (...args) => {
    const adapter = loadAdapter();
    const fn = adapter[name];
    if (typeof fn !== 'function') throw new Error(`${ADAPTER_PACKAGE} does not export ${name}`);
    return fn(...args);
  };
}

function getModule(name) {
  const adapter = loadAdapter();
  return adapter[name];
}

module.exports = {
  deprecated: true,
  adapterPackage: ADAPTER_PACKAGE,
  loadAdapter,

  mountOnOpenClaw: delegate('mountOnOpenClaw'),
  registerAfterburn: delegate('registerAfterburn'),
  registerContextInject: delegate('registerContextInject'),
  registerRecallTool: delegate('registerRecallTool'),
  buildPostProcess: delegate('buildPostProcess'),
  buildSummaryFn: delegate('buildSummaryFn'),
  buildEntityParseFn: delegate('buildEntityParseFn'),

  get instance() { return getModule('instance'); },
  get llm() { return getModule('llm'); },
  get summary() { return getModule('summary'); },
  get dailyEntries() { return getModule('dailyEntries'); },
  get workspaceFiles() { return getModule('workspaceFiles'); },
  get contextInject() { return getModule('contextInject'); },
  get recallFormat() { return getModule('recallFormat'); },
};
