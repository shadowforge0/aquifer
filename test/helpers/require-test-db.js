'use strict';

const { test } = require('node:test');

function registerSkip(reason) {
  test.skip(reason, () => {});
}

function requireTestDb(label) {
  const dbUrl = process.env.AQUIFER_TEST_DB_URL;
  if (!dbUrl) {
    registerSkip(`${label} requires AQUIFER_TEST_DB_URL`);
    return null;
  }
  return dbUrl;
}

module.exports = {
  registerSkip,
  requireTestDb,
};
