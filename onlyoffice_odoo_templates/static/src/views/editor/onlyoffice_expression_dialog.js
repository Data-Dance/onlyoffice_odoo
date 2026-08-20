/** @odoo-module **/

import { Dialog } from "@web/core/dialog/dialog"
import { _t } from "@web/core/l10n/translation"
import { RecordSelector } from "@web/core/record_selectors/record_selector"
import { useService } from "@web/core/utils/hooks"
import { ExportData } from "./onlyoffice_editor_export_data"

const { Component, useState, useRef } = owl

// Reference shown in the Help tab. Kept in sync with _expression_eval_context on the model.
const HELP = {
  variables: [
    { name: "record", desc: "The current record (aliases: object, obj, o)" },
    { name: "user", desc: "The current user (res.users record)" },
    { name: "env", desc: "The environment, e.g. env.company or env['res.partner'].search([...])" },
  ],
  functions: [
    { name: "format_date(value)", desc: "Localized date" },
    { name: "format_datetime(value)", desc: "Localized date and time" },
    { name: "format_amount(amount, currency)", desc: "Localized monetary amount with the currency" },
    { name: "datetime, dateutil, time", desc: "Date/time modules, e.g. datetime.date.today()" },
    { name: "len, abs, min, max, sum, round, sorted, any, all", desc: "Common Python builtins" },
    { name: "str, int, float, bool", desc: "Type conversions" },
  ],
  examples: [
    "record.partner_id.name",
    "record.name.upper()",
    "'%.2f' % record.amount_total",
    "format_amount(record.amount_total, record.currency_id)",
    "'Company' if record.is_company else 'Individual'",
    "', '.join(record.category_id.mapped('name'))",
  ],
}

export class ExpressionDialog extends Component {
  setup() {
    this.orm = useService("orm")
    this.help = HELP
    this.exprRef = useRef("expr")
    this.state = useState({
      tab: "builder",
      expression: this.props.expression || "",
      sampleId: false,
      preview: "",
      previewError: "",
      previewing: false,
      fieldWidth: this.props.fieldWidth ?? 30,
    })
    this._previewTimer = null
  }

  useExample(expression) {
    this.state.expression = expression
    this.state.tab = "builder"
    this.schedulePreview()
  }

  get isEdit() {
    return this.props.mode === "edit"
  }

  // ExportData pick handler: insert the field as a `record.<path>` token.
  onFieldPick(field) {
    this.insertSnippet("record." + field.id.replaceAll("/", "."))
    return true
  }

  insertSnippet(text) {
    const el = this.exprRef.el
    const current = this.state.expression
    let caret = current.length
    if (el && typeof el.selectionStart === "number") {
      const start = el.selectionStart
      const end = el.selectionEnd
      this.state.expression = current.slice(0, start) + text + current.slice(end)
      caret = start + text.length
    } else {
      this.state.expression = current + text
    }
    this.schedulePreview()
    requestAnimationFrame(() => {
      if (this.exprRef.el) {
        this.exprRef.el.focus()
        this.exprRef.el.setSelectionRange(caret, caret)
      }
    })
  }

  onSelectSample(resId) {
    this.state.sampleId = resId
    this.runPreview()
  }

  schedulePreview() {
    if (this._previewTimer) {
      clearTimeout(this._previewTimer)
    }
    this._previewTimer = setTimeout(() => this.runPreview(), 300)
  }

  async runPreview() {
    const expression = this.state.expression.trim()
    if (!expression || !this.state.sampleId) {
      this.state.preview = ""
      this.state.previewError = ""
      return
    }
    this.state.previewing = true
    try {
      const res = await this.orm.call("onlyoffice.odoo.templates", "evaluate_expression_preview", [
        this.props.model,
        this.state.sampleId,
        expression,
      ])
      this.state.preview = res.value
      this.state.previewError = res.error || ""
    } catch (error) {
      this.state.preview = ""
      this.state.previewError = error.message || String(error)
    } finally {
      this.state.previewing = false
    }
  }

  confirm() {
    const expression = this.state.expression.trim()
    if (!expression) {
      return
    }
    const width = parseInt(this.state.fieldWidth, 10)
    this.props.onConfirm(expression, Number.isInteger(width) && width >= 0 ? width : this.props.fieldWidth)
    this.props.close()
  }

  cancel() {
    this.props.close()
  }
}

ExpressionDialog.template = "onlyoffice_odoo_templates.ExpressionDialog"
ExpressionDialog.components = { Dialog, ExportData, RecordSelector }
ExpressionDialog.props = {
  close: Function,
  model: String,
  onConfirm: Function,
  expression: { type: String, optional: true },
  mode: { type: String, optional: true }, // "insert" (default) | "edit"
  fieldWidth: { type: Number, optional: true },
}

// Re-export a translatable default title helper used by callers.
export const expressionDialogTitle = (isEdit) => (isEdit ? _t("Edit expression") : _t("Add expression"))
