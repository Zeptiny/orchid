const { parentPort } = require('node:worker_threads');

parentPort.postMessage({ type: 'ready' });

parentPort.on('message', (message) => {
  if (message.type !== 'execute') return;

  const delayMs = Number(message.delayMs ?? 0);
  setTimeout(() => {
    parentPort.postMessage({
      type: 'result',
      taskId: message.taskId,
      result: message.result ?? 'done',
    });
  }, delayMs);
});
