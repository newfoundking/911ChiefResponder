const express = require('express');
const router = express.Router();
const stations = require('../controllers/stationsController');

router.get('/', stations.getStations);
router.get('/:id', stations.getStation);
router.post('/', stations.createStation);
router.patch('/:id/bays', stations.patchBays);
router.delete('/', stations.deleteStations);

module.exports = router;
