const IDENT_RE = /^[a-z0-9_-]+$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isPositiveIntegerLike(value) {
  if (Number.isInteger(value) && value > 0) return true;
  if (typeof value !== "string") return false;
  if (!/^\d+$/.test(value)) return false;
  return Number(value) > 0;
}

function validWidth(value) {
  if (value === undefined) return true;
  if (value === "all") return true;
  return isPositiveIntegerLike(value);
}

function pushIf(condition, errors, message) {
  if (condition) errors.push(message);
}

export function validateDashboardConfig(config) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(config)) {
    return {
      ok: false,
      errors: ["DASH_CONFIG must be an object."],
      warnings
    };
  }

  pushIf(
    !isNonEmptyString(config.apiBase),
    errors,
    "DASH_CONFIG.apiBase must be a non-empty string."
  );

  if (config.options !== undefined && !isPlainObject(config.options)) {
    errors.push("DASH_CONFIG.options must be an object when provided.");
  }

  const grid = config.options?.grid;
  if (grid !== undefined) {
    if (!isPlainObject(grid)) {
      errors.push("DASH_CONFIG.options.grid must be an object when provided.");
    } else {
      const validColumns = grid.columns === undefined ||
        grid.columns === "auto" ||
        isPositiveIntegerLike(grid.columns);

      pushIf(!validColumns, errors, "Grid columns must be \"auto\" or a positive integer.");
      pushIf(
        grid.minColWidth !== undefined && !isPositiveNumber(grid.minColWidth),
        errors,
        "Grid minColWidth must be a positive number."
      );
      pushIf(
        grid.gap !== undefined && !isNonNegativeNumber(grid.gap),
        errors,
        "Grid gap must be a non-negative number."
      );
      pushIf(
        grid.width !== undefined && typeof grid.width !== "string",
        errors,
        "Grid width must be a string when provided."
      );
    }
  }

  if (!Array.isArray(config.widgets)) {
    errors.push("DASH_CONFIG.widgets must be an array.");
  } else {
    const seenIds = new Set();

    config.widgets.forEach((widget, index) => {
      const prefix = `Widget ${index}`;

      if (!isPlainObject(widget)) {
        errors.push(`${prefix} must be an object.`);
        return;
      }

      pushIf(
        !isNonEmptyString(widget.id) || !IDENT_RE.test(widget.id),
        errors,
        `${prefix} id must be a non-empty identifier using letters, numbers, underscores, or hyphens.`
      );
      pushIf(
        !isNonEmptyString(widget.type) || !IDENT_RE.test(widget.type),
        errors,
        `${prefix} type must be a non-empty identifier using letters, numbers, underscores, or hyphens.`
      );
      pushIf(!validWidth(widget.width), errors, `${prefix} width must be "all" or a positive integer.`);
      pushIf(
        widget.refreshMs !== undefined && !isNonNegativeNumber(widget.refreshMs),
        errors,
        `${prefix} refreshMs must be a non-negative number when provided.`
      );
      pushIf(
        widget.props !== undefined && !isPlainObject(widget.props),
        errors,
        `${prefix} props must be an object when provided.`
      );

      if (isNonEmptyString(widget.id)) {
        if (seenIds.has(widget.id)) {
          errors.push(`Widget id "${widget.id}" is duplicated.`);
        }
        seenIds.add(widget.id);
      }
    });

    if (config.widgets.length === 0) {
      warnings.push("No widgets are enabled.");
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings
  };
}
