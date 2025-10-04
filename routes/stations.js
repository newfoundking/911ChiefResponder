const express = require('express');
const router = express.Router();
const stations = require('../controllers/stationsController');

router.get('/', stations.getStations);
router.get('/:id/personnel', stations.getStationPersonnel);
router.get('/:id', stations.getStation);
router.post('/', stations.createStation);
router.patch('/:id/bays', stations.patchBays);
router.patch('/:id/holding-cells', stations.patchHoldingCells);
router.patch('/:id/equipment-slots', stations.patchEquipmentSlots);
router.patch('/:id/department', stations.patchDepartment);
router.patch('/:id/icon', stations.patchIcon);
router.patch('/:id/name', stations.patchName);
router.delete('/:id', stations.deleteStation);
router.delete('/', stations.deleteStations);
router.post('/:id/equipment', stations.buyEquipment);

module.exports = router;
