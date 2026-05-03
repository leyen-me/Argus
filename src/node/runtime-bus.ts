/**
 * 替代 Electron webContents.send：统一事件出口（WebSocket 等在服务端订阅）。
 * @typedef {{ channel: string, payload: unknown }} BusEnvelope
 */

import { EventEmitter } from "node:events";

const bus = new EventEmitter();
bus.setMaxListeners(200);

/**
 * @param {string} channel
 * @param {unknown} payload
 */
function publish(channel, payload) {
  bus.emit("push", /** @type {BusEnvelope} */ ({ channel, payload }));
}

/**
 * @param {(envelope: BusEnvelope) => void} fn
 * @returns {() => void} unsubscribe
 */
function subscribe(fn) {
  /** @param {BusEnvelope} env */
  const onPush = (env) => {
    fn(env);
  };
  bus.on("push", onPush);
  return () => {
    bus.off("push", onPush);
  };
}

export { publish, subscribe };
