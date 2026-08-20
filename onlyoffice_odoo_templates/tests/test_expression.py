from odoo.tests import tagged
from odoo.tests.common import TransactionCase


@tagged("post_install", "-at_install")
class TestExpressionEvaluation(TransactionCase):
    """Tests for the QWeb-style (t-out) expression evaluation used to fill templates.

    We exercise the model-level core (``_eval_expression_on_record``,
    ``_format_expression_result`` and ``evaluate_expression_preview``) directly, so no
    HTTP layer is needed.
    """

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmpl = cls.env["onlyoffice.odoo.templates"]
        cls.company = cls.env["res.partner"].create({"name": "ACME Corp", "is_company": True})
        cls.contact = cls.env["res.partner"].create(
            {"name": "John Doe", "is_company": False, "parent_id": cls.company.id}
        )

    def _eval(self, expression, record=None):
        return self.tmpl._eval_expression_on_record(expression, record or self.contact)

    # --- field referencing (the core requirement) ---

    def test_char_field_reference(self):
        self.assertEqual(self._eval("record.name"), "John Doe")

    def test_relational_field_reference(self):
        # dotted traversal across a many2one relation
        self.assertEqual(self._eval("record.parent_id.name"), "ACME Corp")

    def test_field_reference_via_aliases(self):
        for alias in ("record", "object", "obj", "o"):
            self.assertEqual(self._eval(f"{alias}.name"), "John Doe")

    def test_boolean_field_true(self):
        self.assertEqual(self._eval("record.is_company", self.company), "True")

    def test_boolean_field_false(self):
        # False is rendered as an empty string (blank field), unlike the integer 0
        self.assertEqual(self._eval("record.is_company", self.contact), "")

    def test_recordset_result_uses_display_name(self):
        self.assertEqual(self._eval("record.parent_id"), self.company.display_name)

    def test_empty_recordset_result(self):
        self.assertEqual(self._eval("record.child_ids", self.contact), "")

    # --- expression mechanics ---

    def test_arithmetic(self):
        self.assertEqual(self._eval("21 * 2"), "42")

    def test_builtin_len(self):
        self.assertEqual(self._eval("len(record.name)"), "8")

    def test_method_call_on_field(self):
        self.assertEqual(self._eval("record.name.upper()"), "JOHN DOE")

    def test_bare_text_function_is_not_defined(self):
        # text transforms must use Python method syntax; upper(x) is undefined -> ""
        self.assertEqual(self._eval("upper(record.name)"), "")
        self.assertEqual(self._eval("record.name.upper()"), "JOHN DOE")

    def test_datetime_module_available(self):
        self.assertEqual(self._eval("datetime.date(2026, 7, 7).year"), "2026")

    def test_string_formatting(self):
        self.assertEqual(self._eval("'%.2f' % (1.0 / 3.0)"), "0.33")

    def test_conditional_expression(self):
        expr = "'Company' if record.is_company else 'Person'"
        self.assertEqual(self._eval(expr, self.company), "Company")
        self.assertEqual(self._eval(expr, self.contact), "Person")

    # --- context helpers ---

    def test_format_amount_helper(self):
        result = self._eval("format_amount(1234.5, env.company.currency_id)")
        self.assertTrue(result)
        self.assertIn("234", result)

    def test_format_date_helper(self):
        result = self._eval("format_date(record.create_date)")
        self.assertTrue(result)
        self.assertIsInstance(result, str)

    def test_user_defaults_to_env_user(self):
        self.assertEqual(self._eval("user.name"), self.env.user.name)

    # --- graceful degradation & security ---

    def test_invalid_field_returns_empty(self):
        self.assertEqual(self._eval("record.does_not_exist"), "")

    def test_syntax_error_returns_empty(self):
        self.assertEqual(self._eval("record."), "")
        self.assertEqual(self._eval(""), "")

    def test_import_is_blocked(self):
        self.assertEqual(self._eval("__import__('os').getcwd()"), "")

    def test_dunder_access_is_blocked(self):
        self.assertEqual(self._eval("record.__class__"), "")

    # --- _format_expression_result unit coverage ---

    def test_format_result_none_and_false(self):
        self.assertEqual(self.tmpl._format_expression_result(None), "")
        self.assertEqual(self.tmpl._format_expression_result(False), "")

    def test_format_result_zero_is_not_empty(self):
        # 0 is falsy but not False -> it must render "0", not an empty string
        self.assertEqual(self.tmpl._format_expression_result(0), "0")

    def test_format_result_true(self):
        self.assertEqual(self.tmpl._format_expression_result(True), "True")

    def test_format_result_numbers_and_str(self):
        self.assertEqual(self.tmpl._format_expression_result(42), "42")
        self.assertEqual(self.tmpl._format_expression_result("hi"), "hi")

    def test_format_result_recordset(self):
        self.assertEqual(self.tmpl._format_expression_result(self.company), self.company.display_name)
        multi = self.company + self.contact
        expected = ", ".join(multi.mapped("display_name"))
        self.assertEqual(self.tmpl._format_expression_result(multi), expected)

    # --- evaluate_expression_preview (editor dialog) ---

    def _preview(self, expression, record=None):
        return self.tmpl.evaluate_expression_preview("res.partner", (record or self.contact).id, expression)

    def test_preview_success(self):
        res = self._preview("record.name.upper()")
        self.assertEqual(res, {"value": "JOHN DOE", "error": False})

    def test_preview_empty_expression(self):
        # nothing typed yet -> no value, no error
        self.assertEqual(self._preview("  "), {"value": "", "error": False})

    def test_preview_surfaces_errors(self):
        # unlike the fill path, the preview reports the error message to the author
        res = self._preview("record.does_not_exist")
        self.assertEqual(res["value"], "")
        self.assertTrue(res["error"])

    def test_preview_missing_record(self):
        res = self.tmpl.evaluate_expression_preview("res.partner", 0, "record.name")
        self.assertEqual(res["value"], "")
        self.assertTrue(res["error"])
