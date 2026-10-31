import { answerKernelRequest } from './kernel-registry.js';

// One thread of heavy scene computation: receives a kernel name and its input, answers with the result.
self.onmessage = (event) => {
  const { response, transfer } = answerKernelRequest(event.data);
  self.postMessage(response, transfer);
};
