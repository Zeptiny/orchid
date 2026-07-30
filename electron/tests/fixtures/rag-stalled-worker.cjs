const { parentPort } = require('node:worker_threads');

parentPort.postMessage({
  type: 'progress',
  progress: {
    phase: 'indexing',
    done: 0,
    total: 1,
    filesIndexed: 0,
    filesSkipped: 0,
    chunksCreated: 0,
    filesDeleted: 0,
    elapsedSeconds: 0,
  },
});

// Deliberately never report another message so the parent watchdog must end it.
setInterval(() => {}, 1_000);
