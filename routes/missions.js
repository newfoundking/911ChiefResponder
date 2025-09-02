const express = require('express');
const router = express.Router();
const missions = require('../controllers/missionsController');

router.get('/', missions.getMissions);
router.post('/', missions.createMission);
router.put('/:id', missions.updateMission);
router.delete('/', missions.deleteMissions);
router.post('/:id/timer', missions.startTimer);
router.patch('/:id/timer', missions.modifyTimer);
router.delete('/:id/timer', missions.clearTimer);

module.exports = router;
