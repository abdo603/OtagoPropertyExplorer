/* Small DOM, formatting, and SQL where-clause helpers. */
(function (global) {
  "use strict";
  function escapeSql(value) { return String(value).replace(/'/g, "''"); }
  function format(value, digits) {
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits == null ? 2 : digits });
  }
  function getObjectIdField(layer) {
    return ((layer.fields || []).find(function (field) { return field.type === "oid"; }) || { name: "OBJECTID" }).name;
  }
  function setOptions(select, items, placeholder, labeler) {
    select.replaceChildren();
    var first = document.createElement("option");
    first.value = "";
    first.textContent = placeholder;
    select.appendChild(first);
    items.forEach(function (item, index) {
      var option = document.createElement("option");
      option.value = item && item.value != null ? item.value : index;
      option.textContent = labeler ? labeler(item) : (item && item.value != null ? item.value : String(item));
      select.appendChild(option);
    });
  }
  function whereLike(field, value) {
    return value ? field + " LIKE '%" + escapeSql(value) + "%'" : "1=1";
  }
  function whereEquals(field, value) {
    return value ? field + " = '" + escapeSql(value) + "'" : "1=1";
  }
  function combineWhere() {
    var parts = Array.from(arguments).filter(function (part) { return part && part !== "1=1"; });
    return parts.length ? parts.map(function (part) { return "(" + part + ")"; }).join(" AND ") : "1=1";
  }
  function setStatus(element, message, kind) {
    element.textContent = message;
    element.className = kind || "";
  }
  global.OtagoUtils = {
    $: function (id) { return document.getElementById(id); },
    escapeSql: escapeSql,
    format: format,
    getObjectIdField: getObjectIdField,
    setOptions: setOptions,
    whereLike: whereLike,
    whereEquals: whereEquals,
    combineWhere: combineWhere,
    setStatus: setStatus
  };
})(window);
