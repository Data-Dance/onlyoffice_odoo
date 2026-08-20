/** @odoo-module **/

import { cookie } from "@web/core/browser/cookie"
import { router } from "@web/core/browser/router"
import { _t } from "@web/core/l10n/translation"
import { rpc } from "@web/core/network/rpc"
import { registry } from "@web/core/registry"
import { useBus, useService } from "@web/core/utils/hooks"
import { ExportData } from "./onlyoffice_editor_export_data"
import { ExpressionDialog } from "./onlyoffice_expression_dialog"
import { FieldWidthDialog } from "./onlyoffice_field_width_dialog"

// Field types inserted as text forms — these carry a per-field width. Checkbox (boolean) and
// picture (binary) forms don't render text, so they skip the width prompt.
const TEXT_FIELD_TYPES = [
  "char",
  "text",
  "selection",
  "integer",
  "float",
  "monetary",
  "date",
  "datetime",
  "many2one",
  "one2many",
  "many2many",
]

const { Component, useState, onMounted, onWillUnmount } = owl

// Must match EXPRESSION_PLUGIN_GUID in controllers/controllers.py — the background plugin
// that adds the "Edit expression" context-menu item and bridges the click back here.
const EXPRESSION_PLUGIN_GUID = "asc.{A1B2C3D4-E5F6-47A8-9B0C-1D2E3F4A5B60}"

// Prefixed to an expression field's placeholder so it is visually distinct from a plain field
// in the editor. It lives only in the placeholder (design-time text), so the filled output —
// which replaces the placeholder with the evaluated value — stays clean.
const EXPRESSION_MARKER = "ƒ "

// Default "Field width": caps the design-time label and the filled value. Overridable per
// template from the expression dialog (persisted on the template's field_display_width). 0 = no cap.
const FIELD_WIDTH_DEFAULT = 30

// Colour applied to expression form text so it stands out in the editor. It does not leak into
// the filled output (the fill replaces the field's text, which renders in the default colour).
const EXPRESSION_COLOR = [124, 58, 173] // violet

// Per-field width marker "#w<N>" appended to a form key (see FIELD_WIDTH_SUFFIX_RE in
// controllers.py). Caps that field's design-time label and filled value to N characters.
const FIELD_WIDTH_RE = /^([\s\S]*)#w(\d+)$/
function parseFieldKey(key) {
  const m = FIELD_WIDTH_RE.exec(key)
  return m ? { base: m[1], width: parseInt(m[2], 10) } : { base: key, width: null }
}
function encodeFieldKey(base, width) {
  return Number.isInteger(width) && width >= 0 ? `${base}#w${width}` : base
}

class TemplateEditor extends Component {
  setup() {
    super.setup(...arguments)
    this.orm = useService("orm")
    this.rpc = rpc
    this.ExportData = ExportData
    this.notificationService = useService("notification")
    this.dialog = useService("dialog")
    this.router = router

    this.state = useState({ resModel: "", fieldWidth: FIELD_WIDTH_DEFAULT })

    this.config = null
    this.docApiJS = null
    this.documentReady = false
    this.hasLicense = false
    this.script = null
    this.unchangedModels = {}

    useBus(this.env.bus, "onlyoffice-template-create-form", (field) => this.onFieldPicked(field.detail))

    // The right-click plugin (running in the editor iframe) posts here when the user picks
    // "Edit expression" (expression fields) or "Edit field width" (direct fields); reopen the
    // matching dialog in edit mode.
    this._onPluginMessage = (ev) => {
      if (ev.origin !== window.location.origin) {
        return
      }
      const data = ev.data
      if (!data || typeof data.key !== "string") {
        return
      }
      if (data.type === "onlyoffice-edit-expression") {
        this.openExpressionDialog(data.key)
      } else if (data.type === "onlyoffice-edit-field-width") {
        this.openFieldWidthDialog(data.key)
      }
    }
    window.addEventListener("message", this._onPluginMessage)

    onMounted(async () => {
      try {
        const attachment_id = this.props.action.params.attachment_id
        const template_model_model = this.props.action.params.template_model_model
        const id = this.props.action.params.id
        this.router.pushState({
          attachment_id: this.props.action.params.attachment_id,
          id: this.props.action.params.id,
          template_model_model: this.props.action.params.template_model_model,
        })

        await this.orm.call("onlyoffice.odoo.templates", "update_relationship", [id, template_model_model])

        this.templateId = id
        const [tmpl] = await this.orm.read("onlyoffice.odoo.templates", [id], ["field_display_width"])
        this.state.fieldWidth = tmpl ? tmpl.field_display_width : FIELD_WIDTH_DEFAULT

        const response = await this.rpc("/onlyoffice/template/editor", { attachment_id: attachment_id })
        const config = JSON.parse(response.editorConfig)

        // Load the Odoo Expressions background plugin (right-click "Edit expression").
        const existingPlugins = config.editorConfig.plugins || {}
        config.editorConfig.plugins = {
          ...existingPlugins,
          autostart: [...(existingPlugins.autostart || []), EXPRESSION_PLUGIN_GUID],
          pluginsData: [
            ...(existingPlugins.pluginsData || []),
            `${window.location.origin}/onlyoffice/template/plugin/config.json`,
          ],
        }

        config.events = {
          onDocumentReady: () => {
            if (window.docEditor && "createConnector" in window.docEditor) {
              window.connector = docEditor.createConnector()
              window.connector.executeMethod("GetVersion", [], () => {
                this.hasLicense = true
                // Mark every expression field in the document (incl. ones added earlier),
                // so they read as expressions regardless of when they were inserted.
                this.markExpressionForms()
              })
            }
            // Render fields
            this.state.resModel = template_model_model
            this.documentReady = true
          },
        }
        const theme = cookie.get("color_scheme")
        config.editorConfig.customization = {
          ...config.editorConfig.customization,
          uiTheme: theme ? `default-${theme}` : "default-light",
        }
        this.config = config

        this.docApiJS = response.docApiJS
        if (!window.DocsAPI) {
          await this.loadDocsAPI(this.docApiJS)
        }
        if (window.DocsAPI) {
          window.docEditor = new DocsAPI.DocEditor("doceditor", this.config)
        } else {
          throw new Error("window.DocsAPI is null")
        }
      } catch (error) {
        console.error("onMounted TemplateEditor error:", error)
        document.getElementById("error").classList.remove("d-none")
      }
    })

    onWillUnmount(() => {
      if (this._onPluginMessage) {
        window.removeEventListener("message", this._onPluginMessage)
      }
      if (window.connector) {
        window.connector.disconnect()
        delete window.connector
      }
      if (window.docEditor) {
        window.docEditor.destroyEditor()
        delete window.docEditor
      }
      if (this.script && this.script.parentNode) {
        this.script.parentNode.removeChild(this.script)
      }
      if (window.DocsAPI) {
        delete window.DocsAPI
      }
    })
  }

  async loadDocsAPI(DocsAPI) {
    return new Promise((resolve, reject) => {
      const script = document.createElement("script")
      script.src = DocsAPI
      script.onload = resolve
      script.onerror = reject
      document.body.appendChild(script)
      this.script = script
    })
  }

  // Style every expression form (key starting with "=") so they read as expressions in the
  // editor: a marked, width-capped placeholder, the full expression in the tooltip, and a
  // distinct bold colour. Runs on document open (retroactive) and after insert/edit. The
  // styling is design-time only — the fill replaces the field text, which renders normally.
  markExpressionForms() {
    if (!window.connector) {
      return
    }
    Asc.scope.marker = EXPRESSION_MARKER
    Asc.scope.tipPrefix = _t("Expression: ")
    Asc.scope.defaultWidth = this.state.fieldWidth || 0
    Asc.scope.color = EXPRESSION_COLOR
    window.connector.callCommand(() => {
      // Split a per-field "#w<N>" width suffix off the key (must mirror parseFieldKey / the
      // Python FIELD_WIDTH_SUFFIX_RE). Forms without it fall back to the template default.
      function parse(key) {
        var m = /^([\s\S]*)#w(\d+)$/.exec(key)
        return m ? { base: m[1], width: parseInt(m[2], 10) } : { base: key, width: null }
      }
      var forms = Api.GetDocument().GetAllForms()
      for (var i = 0; i < forms.length; i++) {
        var parsed = parse(forms[i].GetFormKey())
        if (parsed.base.charAt(0) === "=") {
          var expr = parsed.base.slice(1)
          var maxLen = parsed.width !== null ? parsed.width : Asc.scope.defaultWidth
          var short = maxLen > 0 && expr.length > maxLen ? expr.substring(0, maxLen) + "…" : expr
          forms[i].SetPlaceholderText(Asc.scope.marker + short)
          forms[i].SetTipText(Asc.scope.tipPrefix + expr)
          var pr = forms[i].GetTextPr()
          pr.SetColor(Asc.scope.color[0], Asc.scope.color[1], Asc.scope.color[2], false)
          pr.SetBold(true)
          forms[i].SetTextPr(pr)
        }
      }
    })
  }

  // A field was picked from the tree. Text fields prompt for a width first (then insert with
  // it); checkbox/picture fields have no text to cap, so they insert straight away.
  onFieldPicked(field) {
    if (!TEXT_FIELD_TYPES.includes(field.field_type)) {
      this.createForm(field)
      return
    }
    this.dialog.add(FieldWidthDialog, {
      label: field.formattedString || field.id,
      fieldWidth: this.state.fieldWidth,
      onConfirm: async (fieldWidth) => {
        await this.rememberDefaultWidth(fieldWidth)
        this.createForm({ ...field, width: fieldWidth })
      },
    })
  }

  createForm(field) {
    if (this.documentReady) {
      if (!this.hasLicense) {
        this.notificationService.add(_t("Couldn't insert the field. Please check Automation API."), { type: "danger" })
        return
      }
      // Each text field carries its own width (chars); fall back to the template default.
      const width = Number.isInteger(field.width) && field.width >= 0 ? field.width : this.state.fieldWidth
      Asc.scope.data = field
      Asc.scope.widthSuffix = "#w" + width
      Asc.scope.maxLen = width
      window.connector.callCommand(() => {
        var oDocument = Api.GetDocument()
        var oForm = null
        function truncate(text, max) {
          return max > 0 && text.length > max ? text.substring(0, max) + "…" : text
        }
        if (Asc.scope.data.field_type === "expression") {
          // Store the QWeb-style expression verbatim in the form key (marked with a leading
          // "=" so the fill evaluates it) plus the per-field width suffix. markExpressionForms()
          // styles it (marker, colour, tooltip, truncation) right after insertion.
          oForm = Api.CreateTextForm({
            key: "=" + Asc.scope.data.expression + Asc.scope.widthSuffix,
            placeholder: Asc.scope.data.expression,
            tip: Asc.scope.data.expression,
          })
        } else if (
          [
            "char",
            "text",
            "selection",
            "integer",
            "float",
            "monetary",
            "date",
            "datetime",
            "many2one",
            "one2many",
            "many2many",
          ].includes(Asc.scope.data.field_type)
        ) {
          oForm = Api.CreateTextForm({
            key: Asc.scope.data.id.replaceAll("/", ".") + Asc.scope.widthSuffix,
            placeholder: truncate(Asc.scope.data.formattedString, Asc.scope.maxLen),
            tip: Asc.scope.data.formattedString,
          })
        }
        if (Asc.scope.data.field_type === "boolean") {
          oForm = Api.CreateCheckBoxForm({
            key: Asc.scope.data.id.replaceAll("/", "."),
            tip: Asc.scope.data.formattedString,
          })
        }
        if (Asc.scope.data.field_type === "binary") {
          oForm = Api.CreatePictureForm({
            key: Asc.scope.data.id.replaceAll("/", "."),
            tip: Asc.scope.data.formattedString,
          })
        }
        var oParagraph = Api.CreateParagraph()
        oParagraph.AddElement(oForm)
        oDocument.InsertContent([oParagraph], true, { KeepTextOnly: true })
      })

      if (field.field_type === "expression") {
        this.markExpressionForms()
      }
      window.docEditor.grabFocus()
    }
  }

  // Open the expression builder dialog. Without arguments it inserts a new expression
  // field; passing an existing key (leading "=") opens it in edit mode and updates that
  // form in place on save (used by the right-click plugin bridge).
  openExpressionDialog(existingKey = null) {
    if (!this.state.resModel) {
      return
    }
    const isEdit = typeof existingKey === "string" && existingKey.startsWith("=")
    const parsed = isEdit ? parseFieldKey(existingKey) : { base: "=", width: null }
    this.dialog.add(ExpressionDialog, {
      model: this.state.resModel,
      mode: isEdit ? "edit" : "insert",
      expression: isEdit ? parsed.base.slice(1) : "",
      fieldWidth: isEdit && parsed.width !== null ? parsed.width : this.state.fieldWidth,
      onConfirm: async (expression, fieldWidth) => {
        await this.rememberDefaultWidth(fieldWidth)
        if (isEdit) {
          this.updateExpressionKey(existingKey, encodeFieldKey("=" + expression, fieldWidth))
        } else {
          this.createForm({ field_type: "expression", expression, width: fieldWidth })
        }
      },
    })
  }

  // Remember the last-used width as the template default (pre-fills the next field and caps
  // any older forms that carry no per-field "#w<N>" suffix). Per-field widths live in the keys.
  async rememberDefaultWidth(fieldWidth) {
    const width = Number.isInteger(fieldWidth) && fieldWidth >= 0 ? fieldWidth : this.state.fieldWidth
    if (width === this.state.fieldWidth) {
      return
    }
    this.state.fieldWidth = width
    if (this.templateId) {
      await this.orm.write("onlyoffice.odoo.templates", [this.templateId], { field_display_width: width })
    }
    this.markExpressionForms()
  }

  // Edit the width of an existing direct field in place (right-click plugin bridge). Opens the
  // compact width prompt pre-filled with the field's current width, then re-encodes its key.
  openFieldWidthDialog(existingKey) {
    if (!this.state.resModel || typeof existingKey !== "string") {
      return
    }
    const parsed = parseFieldKey(existingKey)
    this.dialog.add(FieldWidthDialog, {
      mode: "edit",
      label: parsed.base,
      fieldWidth: parsed.width !== null ? parsed.width : this.state.fieldWidth,
      onConfirm: async (fieldWidth) => {
        await this.rememberDefaultWidth(fieldWidth)
        this.updateDirectFieldWidth(existingKey, fieldWidth)
      },
    })
  }

  // Re-encode a direct field's key with a new width and re-truncate its placeholder (the full
  // label is preserved in the tooltip), matched by its current key.
  updateDirectFieldWidth(oldKey, newWidth) {
    if (!this.documentReady || !window.connector) {
      return
    }
    const parsed = parseFieldKey(oldKey)
    Asc.scope.oldKey = oldKey
    Asc.scope.newKey = encodeFieldKey(parsed.base, newWidth)
    Asc.scope.maxLen = Number.isInteger(newWidth) ? newWidth : 0
    window.connector.callCommand(() => {
      function truncate(text, max) {
        return max > 0 && text.length > max ? text.substring(0, max) + "…" : text
      }
      var forms = Api.GetDocument().GetAllForms()
      for (var i = 0; i < forms.length; i++) {
        if (forms[i].GetFormKey() === Asc.scope.oldKey) {
          forms[i].SetFormKey(Asc.scope.newKey)
          // The tooltip holds the full field label; re-derive the truncated placeholder from it.
          var label = forms[i].GetTipText ? forms[i].GetTipText() : ""
          if (label) {
            forms[i].SetPlaceholderText(truncate(label, Asc.scope.maxLen))
          }
          break
        }
      }
    })
    window.docEditor.grabFocus()
  }

  // Replace the key (and tip) of an existing expression form, matched by its current key.
  updateExpressionKey(oldKey, newKey) {
    if (!this.documentReady || !window.connector) {
      return
    }
    Asc.scope.oldKey = oldKey
    Asc.scope.newKey = newKey
    window.connector.callCommand(() => {
      var forms = Api.GetDocument().GetAllForms()
      for (var i = 0; i < forms.length; i++) {
        if (forms[i].GetFormKey() === Asc.scope.oldKey) {
          forms[i].SetFormKey(Asc.scope.newKey)
          break
        }
      }
    })
    this.markExpressionForms()
    window.docEditor.grabFocus()
  }
}
TemplateEditor.components = {
  ...Component.components,
  ExportData,
}
TemplateEditor.template = "onlyoffice_odoo_templates.TemplateEditor"

registry.category("actions").add("onlyoffice_template_editor", TemplateEditor)
