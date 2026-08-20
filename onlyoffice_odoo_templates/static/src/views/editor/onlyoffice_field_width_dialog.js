/** @odoo-module **/

import { Dialog } from "@web/core/dialog/dialog"

const { Component, useState } = owl

// Small prompt shown when inserting a direct (non-expression) field, so the author can set that
// field's width — the number of characters it may render before the filled value is truncated
// with "…". The chosen width is encoded into the form key (see encodeFieldKey in the editor).
export class FieldWidthDialog extends Component {
  setup() {
    this.state = useState({ fieldWidth: this.props.fieldWidth ?? 30 })
  }

  get isEdit() {
    return this.props.mode === "edit"
  }

  confirm() {
    const width = parseInt(this.state.fieldWidth, 10)
    this.props.onConfirm(Number.isInteger(width) && width >= 0 ? width : this.props.fieldWidth)
    this.props.close()
  }

  onKeydown(ev) {
    if (ev.key === "Enter") {
      this.confirm()
    }
  }
}
FieldWidthDialog.components = { Dialog }
FieldWidthDialog.template = "onlyoffice_odoo_templates.FieldWidthDialog"
FieldWidthDialog.props = {
  close: Function,
  onConfirm: Function,
  label: { type: String, optional: true },
  fieldWidth: { type: Number, optional: true },
  mode: { type: String, optional: true }, // "insert" (default) | "edit"
}
