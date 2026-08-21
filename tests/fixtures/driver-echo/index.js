/**
 * The smallest complete external driver, used by the driver-loading tests.
 *
 * A driver is plain JavaScript an operator drops into the instance's drivers/
 * directory: it imports nothing from Yap (the whole contract arrives by
 * injection through the run context) and default-exports one definition
 * object. This one takes no config, needs no network, and echoes its
 * parameter back — quietly (`echo`) or loudly (`shout`). Two actions, so a
 * service's per-action allowlist has something to restrict.
 */
export default {
  name: "echo",
  api: 1,
  description: "Echoes a message back.",
  egress: false,
  configDoc: "No configuration: {}",
  validateConfig() {},
  actions: {
    echo: {
      description: "Echoes the supplied message.",
      params: [{ name: "message", description: "What to echo back", required: true }],
      timeoutMs: 5000,
    },
    shout: {
      description: "Echoes the supplied message in upper case.",
      params: [{ name: "message", description: "What to shout back", required: true }],
      timeoutMs: 5000,
    },
  },
  async run(ctx) {
    if (ctx.action === "shout") return { shouted: ctx.params.message.toUpperCase() };
    return { echoed: ctx.params.message };
  },
};
