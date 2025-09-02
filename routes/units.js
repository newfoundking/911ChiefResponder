const express = require('express');
const router = express.Router();
const units = require('../controllers/unitsController');

router.get('/', units.getUnits);
router.get('/:id', units.getUnit);
router.patch('/:id', units.updateUnit);
router.patch('/:id/status', units.patchStatus);
router.patch('/:id/patrol', units.patchPatrol);
router.patch('/:id/icon', units.patchIcon);
router.post('/:id/cancel', units.cancelUnit);

module.exports = router;
