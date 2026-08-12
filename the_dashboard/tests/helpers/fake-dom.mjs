export class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  toggle(value, force) {
    const enabled = force ?? !this.contains(value);
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
}

export class FakeElement {
  constructor(tagName = "div", { supportsPopover = false } = {}) {
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.events = new Map();
    this.focusCalls = 0;
    this.hidePopoverCalls = 0;
    this.showPopoverCalls = 0;
    this.style = { setProperty() {} };
    this.tagName = tagName;
    this.textContent = "";
    this.value = "";

    if (supportsPopover) {
      this.hidePopover = () => {
        this.hidePopoverCalls += 1;
      };
      this.showPopover = () => {
        this.showPopoverCalls += 1;
      };
    }
  }

  set className(value) {
    this.classList.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(" ");
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.events.get(type) || new Set();
    listeners.add(listener);
    this.events.set(type, listeners);
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    if (child.parentElement) {
      const previousIndex = child.parentElement.children.indexOf(child);
      if (previousIndex >= 0) child.parentElement.children.splice(previousIndex, 1);
    }
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  createEvent(values = {}) {
    return {
      target: this,
      currentTarget: this,
      key: values.key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      }
    };
  }

  fire(type, values = {}) {
    const event = this.createEvent(values);
    for (const listener of this.events.get(type) || []) listener(event);
    return event;
  }

  async fireAsync(type, values = {}) {
    const event = this.createEvent(values);
    for (const listener of this.events.get(type) || []) await listener(event);
    return event;
  }

  focus() {
    this.focusCalls += 1;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentElement = null;
    this.children = [];
    this.append(...children);
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
      child.parentElement = null;
    }
    return child;
  }
}

export class FakeDocument {
  constructor({ supportsPopover = false } = {}) {
    this.head = new FakeElement("head");
    this.listeners = new Map();
    this.supportsPopover = supportsPopover;
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  createElement(tagName) {
    return new FakeElement(tagName, { supportsPopover: this.supportsPopover });
  }

  getElementById(id) {
    function find(element) {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = find(child);
        if (match) return match;
      }
      return null;
    }
    return find(this.head);
  }

  fire(type, { target, key } = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ target, key });
    }
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
}

export function treeText(element) {
  return [element.textContent, ...element.children.map(treeText)].join(" ");
}

export function findAll(element, predicate) {
  const matches = predicate(element) ? [element] : [];
  for (const child of element.children) {
    matches.push(...findAll(child, predicate));
  }
  return matches;
}

export function findByClass(element, className) {
  return findAll(
    element,
    (candidate) => candidate.classList.contains(className)
  )[0] || null;
}
