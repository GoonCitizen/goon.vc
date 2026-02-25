'use strict';

const assert = require('assert');
const GOON = require('../services/goon.vc');

describe('goon.vc', function () {
  describe('GOON', function () {
    this.timeout(10000);

    it('provides a valid contract', function () {
      const goon = new GOON();
      assert.ok(goon);
      assert.ok(goon.contract);
    });
  });
});
