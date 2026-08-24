# License AGPL-3.0 or later (https://www.gnu.org/licenses/agpl).

import logging

from odoo import SUPERUSER_ID, api

_logger = logging.getLogger(__name__)

OFFICE_MIMETYPES = {
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.oasis.opendocument.text": "odt",
}


def migrate(cr, version):
    """Name an office template after its own format.

    Templates kept as office documents were still filed as "<name>.pdf", and
    ONLYOFFICE reads the format off the extension: opening one failed with "the
    file content corresponds to text documents (e.g. docx), but the file has the
    inconsistent extension: pdf". Filling them worked throughout, so the only
    symptom was that no template could be opened for editing.
    """
    env = api.Environment(cr, SUPERUSER_ID, {})
    templates = env["onlyoffice.odoo.templates"].search([])
    renamed = 0
    for template in templates:
        attachment = template.attachment_id
        extension = OFFICE_MIMETYPES.get(attachment.mimetype)
        if not extension or not (attachment.name or "").lower().endswith(".pdf"):
            continue
        attachment.name = "%s.%s" % (attachment.name[: -len(".pdf")], extension)
        renamed += 1
    if renamed:
        _logger.info("Renamed %s office templates to match their format.", renamed)
