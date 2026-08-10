import { createElement } from "../platform/global.js";

window.DASH.registerWidget("text", {
  mount(root, { props = {} }) {
    const body = createElement("div", "widget-body label-info");
    body.textContent = props.text ?? "";
    root.replaceChildren(body);
  }
});
