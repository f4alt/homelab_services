import { createElement, fetchJson } from "../platform/global.js";

window.DASH.registerWidget("text", {
  mount(root, { props = {} }) {
    const body = createElement("div", "widget-body label-info");
    body.textContent = props.text ?? "";
    root.replaceChildren(body);
    return { body, props };
  },

  async update(state) {
    if (!state.props?.fetchUrl) return;
    const data = await fetchJson(state.props.fetchUrl, { envelope: false });
    state.body.textContent = typeof data === "string" ? data : JSON.stringify(data);
  }
});
