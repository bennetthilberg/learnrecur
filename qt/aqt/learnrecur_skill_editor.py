# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Create and revise skills, with optional exercise inspection."""

from __future__ import annotations

import re
from uuid import UUID, uuid4

import requests

import aqt
from anki.learnrecur_skill_import import (
    FIELDS,
    MAX_BYTES,
    SkillImportError,
    _cache_update_fields,
    _text,
    decode,
    encode,
    import_snapshot,
    validate_snapshot,
)
from aqt import colors, gui_hooks
from aqt.learnrecur_import import companion_connection, fetch_snapshot
from aqt.operations import CollectionOp, QueryOp
from aqt.qt import (
    QDialog,
    QDialogButtonBox,
    QEvent,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QPainter,
    QPen,
    QPlainTextEdit,
    QPoint,
    QPointF,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QStackedWidget,
    Qt,
    QTabWidget,
    QTimer,
    QToolButton,
    QToolTip,
    QVariantAnimation,
    QVBoxLayout,
    QWidget,
)
from aqt.theme import theme_manager
from aqt.utils import disable_help_button, showWarning

PENDING_KEY = "learnrecur_skill_creation"
STATES = {
    "queued": "",
    "running": "Generating…",
    "provider_pending": "Generating…",
    "retry_wait": "Retrying…",
    "result_ready": "Saving exercises…",
    "waiting_budget": "Waiting for budget.",
    "waiting_capacity": "Waiting for storage.",
    "needs_attention": "Generation needs recovery.",
    "failed": "Generation failed.",
    "obsolete": "The skill definition changed.",
    "completed": "",
}
ERRORS = {
    "Generation is not enabled on this server.",
    "Generation is paused for recovery.",
    "The companion can hold at most 100 skills.",
    "The companion has reached its skill limit.",
    "The companion has reached its generation job limit.",
    "The companion has no room for another exercise bank.",
    "The companion changed. Reconnect to the original server.",
    "This request already has a different skill definition.",
    "The skill changed. Import its latest revision before editing.",
    "This skill has pending changes. Resume the saved request first.",
    "This skill is no longer available.",
}


def validate_definition(value):
    fields = {
        "request_id",
        "source_id",
        "title",
        "description",
        "examples",
    }
    if not isinstance(value, dict) or set(value) not in (
        fields,
        fields | {"skill_id", "base_revision"},
    ):
        raise SkillImportError("Invalid saved skill request.")
    if "skill_id" in value and (
        not isinstance(value["skill_id"], str)
        or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", value["skill_id"])
        or type(value["base_revision"]) is not int
        or not 1 <= value["base_revision"] < 100
    ):
        raise SkillImportError("Use a skill revision below 100.")
    if not isinstance(value["request_id"], str) or not re.fullmatch(
        r"[a-f0-9]{32}", value["request_id"]
    ):
        raise SkillImportError("Invalid saved skill request.")
    try:
        if str(UUID(value["source_id"])) != value["source_id"]:
            raise ValueError()
    except (ValueError, TypeError, AttributeError):
        raise SkillImportError("Invalid companion identity.") from None
    _text(value["title"], 256)
    _text(value["description"])
    if not isinstance(value["examples"], list) or len(value["examples"]) > 5:
        raise SkillImportError("Use at most five examples.")
    for example in value["examples"]:
        if not isinstance(example, dict) or set(example) != {
            "prompt",
            "answer",
            "explanation",
        }:
            raise SkillImportError("Invalid example exercise.")
        for text in example.values():
            _text(text)
    if len(encode(value).encode()) > 65536:
        raise SkillImportError("The skill description and examples are too long.")
    return value


def companion_request(connection, route, payload=None):
    url, token = connection
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.request(
                "POST" if payload is not None else "GET",
                url + route,
                json=payload,
                headers={"Authorization": "Bearer " + token},
                timeout=(3, 5),
                allow_redirects=False,
                stream=True,
            ) as response:
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise SkillImportError("The companion response is too large.")
                if response.status_code == 401:
                    raise SkillImportError("The companion token was rejected.")
                if response.status_code == 404:
                    raise SkillImportError(
                        "Update the companion before using the skill editor."
                    )
                value = decode(bytes(data))
                if response.status_code != 200:
                    error = value.get("error") if isinstance(value, dict) else None
                    raise SkillImportError(
                        error
                        if isinstance(error, str) and error in ERRORS
                        else "The companion could not accept the request. Retry later."
                    )
        return value
    except requests.RequestException:
        raise SkillImportError(
            "Could not reach the companion. Retry to check the request."
        ) from None


def request_job(connection, payload, job_id=None):
    route = (
        "/v1/generation-jobs/" + job_id
        if job_id
        else ("/v1/skill-edits" if "skill_id" in payload else "/v1/skill-drafts")
    )
    value = companion_request(connection, route, None if job_id else payload)
    if (
        not isinstance(value, dict)
        or not isinstance(value.get("id"), str)
        or not re.fullmatch(r"[a-f0-9]{32}", value["id"])
        or job_id
        and value["id"] != job_id
        or not isinstance(value.get("state"), str)
        or value["state"] not in STATES
        or not isinstance(value.get("request"), dict)
        or any(value["request"].get(key) != item for key, item in payload.items())
    ):
        raise SkillImportError("The companion returned another skill request.")
    return value


def creation_snapshot(snapshot, definition):
    source, skills = validate_snapshot(snapshot)
    if source != definition["source_id"]:
        raise SkillImportError(
            "The companion changed. Reconnect to the original server."
        )
    key = definition.get("skill_id", "skill-" + definition["request_id"])
    skill = next((skill for skill in skills if skill["id"] == key), None)
    generated = next(
        (
            version
            for version in [*snapshot.get("previous_revisions", {}).get(key, []), skill]
            if version
            and version["bank"]["revision"] == definition.get("base_revision", 0) + 1
        ),
        None,
    )
    if (
        not generated
        or generated["title"] != definition["title"]
        or generated["description"] != definition["description"]
        or "identities" not in snapshot
    ):
        raise SkillImportError("The generated skill is missing or changed.")
    result = {
        "source_id": source,
        "skills": [skill],
        "identities": {key: snapshot["identities"][key]},
    }
    for field in ("previous_revisions", "bank_updates"):
        if key in snapshot.get(field, {}):
            result[field] = {key: snapshot[field][key]}
    validate_snapshot(result)
    return result


def selected_skill(col, nid):
    from anki.learnrecur_skill_links import assert_unique_link, link_key
    from anki.learnrecur_skills import MODEL_KIND, MODEL_MARKER, SkillReviewError

    note = col.get_note(nid)
    cards = note.cards()
    if (
        note.note_type().get(MODEL_MARKER) != MODEL_KIND
        or len(cards) != 1
        or any(field not in note for field in FIELDS)
    ):
        raise SkillImportError("Select one imported skill.")
    try:
        key = link_key(note)
        assert_unique_link(cards[0])
    except SkillReviewError as error:
        raise SkillImportError(str(error)) from None
    if not key or not col.db.scalar(
        "select exists(select 1 from learnrecur_skill_identities where nid=? and cid=? and guid=?)",
        note.id,
        cards[0].id,
        note.guid,
    ):
        raise SkillImportError("This skill has no trusted import identity.")
    bank = decode(note["LearnRecurSkill"].encode())
    if not isinstance(bank, dict) or type(bank.get("revision")) is not int:
        raise SkillImportError("Invalid cached exercise bank.")
    return {"source_id": key[0], "skill_id": key[1], "base_revision": bank["revision"]}


def validate_edit_target(col, snapshot, definition, *, completed=False):
    if snapshot["source_id"] != definition["source_id"]:
        raise SkillImportError(
            "The companion changed. Reconnect to the original server."
        )
    key = definition["skill_id"]
    identity = snapshot["identities"].get(key)
    if not identity:
        raise SkillImportError("This skill is no longer available.")
    if not col.db.scalar(
        "select exists(select 1 from notes where id=?)", identity["native_id"]
    ):
        raise SkillImportError(
            "The original skill card is missing. Restore it before saving changes."
        )
    target = selected_skill(col, identity["native_id"])
    skill = next((s for s in snapshot["skills"] if s["id"] == key), None)
    if not skill or (
        skill["bank"]["revision"] < definition["base_revision"] + 1
        if completed
        else skill["bank"]["revision"] != definition["base_revision"]
    ):
        raise SkillImportError(
            "The skill changed. Import its latest revision before editing."
        )
    if (
        target["source_id"] != definition["source_id"]
        or target["skill_id"] != key
        or not (
            definition["base_revision"]
            <= target["base_revision"]
            <= skill["bank"]["revision"]
            if completed
            else target["base_revision"] == definition["base_revision"]
        )
        or col.get_note(identity["native_id"]).guid != identity["guid"]
    ):
        raise SkillImportError(
            "The skill changed. Import its latest revision before editing."
        )
    _cache_update_fields(
        target["source_id"],
        key,
        col.get_note(identity["native_id"]),
        skill,
        snapshot.get("previous_revisions", {}).get(key, []),
        snapshot.get("bank_updates", {}).get(key, []),
        snapshot["identities"],
    )


def fetch_definition(connection, target):
    value = companion_request(connection, "/v1/skill-definitions/" + target["skill_id"])
    definition = (
        validate_definition({**value, "request_id": "0" * 32})
        if isinstance(value, dict)
        else None
    )
    if not definition or any(
        definition.get(key) != item for key, item in target.items()
    ):
        raise SkillImportError(
            "The skill changed. Import its latest revision before editing."
        )
    return value, fetch_snapshot(connection)


def text_field(name, height, *, readonly=False):
    field = QPlainTextEdit()
    field.setAttribute(Qt.WidgetAttribute.WA_MacShowFocusRect, False)
    field.setAccessibleName(name)
    field.setTabChangesFocus(True)
    field.setReadOnly(readonly)
    field.setFixedHeight(height)
    font = field.font()
    font.setPointSizeF(max(font.pointSizeF(), 18))
    field.setFont(font)
    field.document().setDocumentMargin(10)
    return field


def form_row(form, name, field, *, help_text=None):
    form.addWidget(FieldSection(name, field, help_text=help_text))


def style_editor(widget):
    color = theme_manager.var
    widget.setStyleSheet(
        f"""
        QLineEdit, QPlainTextEdit, QListWidget {{
            background: {color(colors.CANVAS_ELEVATED)};
            color: {color(colors.FG)};
            border: 1px solid {color(colors.BORDER_SUBTLE)};
            padding: 1px;
            border-radius: 5px;
            selection-background-color: {color(colors.BORDER_FOCUS)};
        }}
        QLineEdit:focus, QPlainTextEdit:focus, QListWidget:focus {{
            border: 2px solid {color(colors.BORDER_FOCUS)};
            padding: 0px;
        }}
        QFocusFrame {{ border: none; background: transparent; }}
        QToolButton[fieldHeader="true"] {{
            border: 1px solid transparent; background: transparent;
            padding: 4px 2px 4px 20px; font-size: 16pt;
        }}
        QToolButton[fieldHeader="true"]:focus {{
            border-color: {color(colors.BORDER_FOCUS)}; border-radius: 3px;
        }}
        QToolButton[fieldHelp="true"] {{
            border: 1px solid transparent; background: transparent;
            color: {color(colors.FG_SUBTLE)}; font-size: 14pt;
        }}
        QToolButton[fieldHelp="true"]:hover {{ color: {color(colors.FG)}; }}
        QToolButton[fieldHelp="true"]:focus {{
            border-color: {color(colors.BORDER_FOCUS)}; border-radius: 3px;
        }}
        QScrollArea {{ border: none; background: transparent; }}
        """
    )


class FieldHeader(QToolButton):
    """Native collapse button with the editor's small, dim chevron."""

    def __init__(self, name, parent):
        super().__init__(parent)
        self.setProperty("fieldHeader", True)
        self.setText(name)
        self.setCheckable(True)
        self.setChecked(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.opacity = 0.4
        self.fade = QVariantAnimation(self)
        self.fade.setDuration(120)
        self.fade.valueChanged.connect(self.fade_changed)

    def fade_changed(self, value):
        self.opacity = value
        self.update()

    def hover(self, target):
        self.fade.stop()
        reduce_motion = getattr(getattr(aqt.mw, "pm", None), "reduce_motion", None)
        if reduce_motion and reduce_motion():
            self.fade_changed(target)
        else:
            self.fade.setStartValue(self.opacity)
            self.fade.setEndValue(target)
            self.fade.start()

    def enterEvent(self, event):
        self.hover(1.0)
        super().enterEvent(event)

    def leaveEvent(self, event):
        self.hover(0.4)
        super().leaveEvent(event)

    def paintEvent(self, event):
        super().paintEvent(event)
        painter = QPainter(self)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        color = theme_manager.qcolor(colors.FG)
        color.setAlphaF(self.opacity)
        painter.setPen(QPen(color, 1.5))
        y = self.height() / 2
        points = (
            ((6, y - 2), (10, y + 2), (14, y - 2))
            if self.isChecked()
            else ((8, y - 4), (12, y), (8, y + 4))
        )
        painter.drawLine(QPointF(*points[0]), QPointF(*points[1]))
        painter.drawLine(QPointF(*points[1]), QPointF(*points[2]))


class FieldHelp(QToolButton):
    def __init__(self, name, text, parent):
        super().__init__(parent)
        self.setProperty("fieldHelp", True)
        self.setText("ⓘ")
        self.setFixedSize(24, 28)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.setAccessibleName("About " + name.replace("&", ""))
        self.setAccessibleDescription(text)
        self.setToolTip(f'<table width="320"><tr><td>{text}</td></tr></table>')
        self.clicked.connect(self.show_help)

    def show_help(self):
        QToolTip.showText(
            self.mapToGlobal(QPoint(self.width() + 2, -8)),
            self.toolTip(),
            self,
            self.rect(),
        )

    def enterEvent(self, event):
        super().enterEvent(event)
        self.show_help()

    def leaveEvent(self, event):
        QToolTip.hideText()
        super().leaveEvent(event)

    def event(self, event):
        if event.type() == QEvent.Type.ToolTip:
            self.show_help()
            return True
        return super().event(event)


class FieldSection(QWidget):
    def __init__(self, name, body, *, help_text=None):
        super().__init__()
        self.header = FieldHeader(name, self)
        self.body = body
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        heading = QHBoxLayout()
        heading.setSpacing(4)
        heading.addWidget(self.header)
        if help_text:
            heading.addWidget(FieldHelp(name, help_text, self))
        heading.addStretch()
        layout.addLayout(heading)
        layout.addWidget(body)
        self.header.toggled.connect(self.toggle)
        self.toggle(True)

    def toggle(self, expanded):
        self.body.setVisible(expanded)
        self.header.setAccessibleName(
            ("Collapse " if expanded else "Expand ")
            + self.header.text().replace("&", "")
        )
        self.header.update()


class ExampleDialog(QDialog):
    def __init__(self, parent, example=None):
        super().__init__(parent)
        self.setWindowTitle("Example exercise")
        font = self.font()
        font.setPointSizeF(max(font.pointSizeF(), 15))
        self.setFont(font)
        style_editor(self)
        disable_help_button(self)
        layout = QVBoxLayout(self)
        form = QVBoxLayout()
        form.setSpacing(20)
        self.fields = {
            "prompt": text_field("Prompt", 70),
            "answer": text_field("Answer", 45),
            "explanation": text_field("Explanation", 70),
        }
        for key, field in self.fields.items():
            field.setPlainText((example or {}).get(key, ""))
            form_row(form, key.capitalize(), field)
            field.textChanged.connect(self.changed)
        layout.addLayout(form)
        self.buttons = QDialogButtonBox(
            QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
            parent=self,
        )
        self.buttons.accepted.connect(self.accept)
        self.buttons.rejected.connect(self.reject)
        layout.addWidget(self.buttons)
        self.resize(640, 450)
        self.changed()
        self.fields["prompt"].setFocus()

    def changed(self):
        self.buttons.button(QDialogButtonBox.StandardButton.Ok).setEnabled(
            all(field.toPlainText().strip() for field in self.fields.values())
        )

    def example(self):
        result = {
            key: field.toPlainText().strip() for key, field in self.fields.items()
        }
        for value in result.values():
            _text(value)
        return result


class ExercisePreview(QDialog):
    def __init__(self, parent, snapshot):
        super().__init__(parent)
        self.setWindowTitle("Preview exercises")
        self.setFont(parent.font())
        style_editor(self)
        disable_help_button(self)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        title = QLabel(snapshot["skills"][0]["title"])
        title.setTextFormat(Qt.TextFormat.PlainText)
        title.setWordWrap(True)
        title.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        font = title.font()
        font.setPointSizeF(18)
        title.setFont(font)
        layout.addWidget(title)
        tabs = QTabWidget()
        for index, exercise in enumerate(snapshot["skills"][0]["bank"]["exercises"], 1):
            tab = QWidget()
            form = QVBoxLayout(tab)
            form.setSpacing(12)
            for key, height in (("prompt", 88), ("answer", 60), ("explanation", 88)):
                field = text_field(key.capitalize(), height, readonly=True)
                field.setPlainText(exercise[key])
                form_row(form, key.capitalize(), field)
            form.addStretch()
            tabs.addTab(tab, f"Exercise {index}")
        layout.addWidget(tabs)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.resize(840, 580)


class SkillEditor(QDialog):
    def __init__(self, mw, editing=None):
        super().__init__(None, Qt.WindowType.Window)
        self.mw = mw
        self.collection = mw.col
        self.profile = mw.pm.profile
        self.connection = companion_connection()
        self.closed = False
        self.busy = False
        self.frozen = False
        self.added = False
        self.pending = self.profile.get(PENDING_KEY)
        if self.pending is not None:
            validate_definition(self.pending)
        self.editing = editing
        if self.pending is not None:
            self.editing = (
                {
                    key: self.pending[key]
                    for key in ("source_id", "skill_id", "base_revision")
                }
                if "skill_id" in self.pending
                else None
            )
        self.original = None
        self.job_id = None
        self.snapshot = None
        self.examples = []
        self.setWindowTitle("Edit skill" if self.editing else "Add skill")
        font = self.font()
        font.setPointSizeF(max(font.pointSizeF(), 15))
        self.setFont(font)
        style_editor(self)
        self.setWindowFlag(Qt.WindowType.WindowMinMaxButtonsHint, True)
        disable_help_button(self)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(16)
        self.pages = QStackedWidget()
        entry = QWidget()
        entry_layout = QVBoxLayout(entry)
        entry_layout.setContentsMargins(0, 0, 0, 0)
        entry_layout.setSpacing(16)
        form = QVBoxLayout()
        form.setSpacing(16)
        self.title = QLineEdit()
        self.title.setAttribute(Qt.WidgetAttribute.WA_MacShowFocusRect, False)
        self.title.setAccessibleName("Title")
        font = self.title.font()
        font.setPointSizeF(max(font.pointSizeF(), 18))
        self.title.setFont(font)
        self.title.setFixedHeight(48)
        self.title.setTextMargins(10, 8, 10, 8)
        self.description = text_field("Description", 88)
        self.description.setFixedHeight(88)
        form_row(form, "&Title", self.title)
        form_row(
            form,
            "&Description",
            self.description,
            help_text=(
                "Describe the rule or procedure to practice, including what to "
                "include or exclude. Keep it specific enough that every exercise "
                "tests the same skill."
            ),
        )
        self.title.textChanged.connect(self.changed)
        self.description.textChanged.connect(self.changed)
        entry_layout.addLayout(form)
        self.example_group = QWidget()
        self.example_group.setSizePolicy(
            QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Maximum
        )
        examples_layout = QVBoxLayout(self.example_group)
        examples_layout.setContentsMargins(0, 0, 0, 0)
        examples_layout.setSpacing(12)
        self.example_list = QListWidget()
        self.example_list.setAttribute(Qt.WidgetAttribute.WA_MacShowFocusRect, False)
        self.example_list.setAccessibleName("Examples")
        self.example_list.setFixedHeight(100)
        self.example_list.setSpacing(4)
        self.example_list.currentRowChanged.connect(self.changed)
        self.example_list.itemSelectionChanged.connect(self.changed)
        self.example_list.itemDoubleClicked.connect(lambda _: self.edit_example())
        examples_layout.addWidget(self.example_list)
        row = QHBoxLayout()
        self.add_example_button = QPushButton("Add example…")
        self.edit_example_button = QPushButton("Edit…")
        self.remove_example_button = QPushButton("Remove")
        for button in (
            self.add_example_button,
            self.edit_example_button,
            self.remove_example_button,
        ):
            button.setAutoDefault(False)
            row.addWidget(button)
        row.addStretch()
        self.add_example_button.clicked.connect(self.add_example)
        self.edit_example_button.clicked.connect(self.edit_example)
        self.remove_example_button.clicked.connect(self.remove_example)
        examples_layout.addLayout(row)
        self.example_section = FieldSection(
            "Examples (optional)",
            self.example_group,
            help_text=(
                "Add up to five exercises with a prompt, correct answer, and brief "
                "explanation. Choose examples that show the format and difficulty "
                "you want. They guide generation and aren't added directly to reviews."
            ),
        )
        entry_layout.addWidget(self.example_section)
        entry_layout.addStretch()
        entry_scroll = QScrollArea()
        entry_scroll.setWidgetResizable(True)
        entry_scroll.setWidget(entry)
        self.pages.addWidget(entry_scroll)
        layout.addWidget(self.pages, stretch=1)
        self.status = QLabel()
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        self.status.hide()
        layout.addWidget(self.status)
        self.progress = QProgressBar()
        self.progress.setRange(0, 0)
        self.progress.setTextVisible(False)
        self.progress.setAccessibleName("Generating exercises")
        self.progress.hide()
        layout.addWidget(self.progress)
        layout.addWidget(self.create_footer())
        self.timer = QTimer(self)
        self.timer.setInterval(2000)
        self.timer.timeout.connect(self.poll)
        self.resize(840, 660)
        self.setMinimumSize(640, 500)
        if self.pending is not None:
            self.title.setText(self.pending["title"])
            self.description.setPlainText(self.pending["description"])
            self.examples = list(self.pending["examples"])
            self.refresh_examples()
            self.freeze(True)
            self.processing("Generating…")
            QTimer.singleShot(0, self.submit)
        elif self.editing:
            self.freeze(True)
            QTimer.singleShot(0, self.load_definition)
        else:
            self.refresh_examples()
        self.changed()
        self.title.setFocus()
        gui_hooks.profile_will_close.append(self.reject)
        gui_hooks.theme_did_change.append(self.retheme)

    def load_definition(self):
        def loaded(value):
            definition, snapshot = value
            try:
                validate_edit_target(self.collection, snapshot, definition)
            except SkillImportError as error:
                self.message(str(error))
                self.action.setEnabled(False)
                return
            self.original = definition
            self.title.setText(definition["title"])
            self.description.setPlainText(definition["description"])
            self.examples = list(definition["examples"])
            self.refresh_examples()
            self.processing()
            self.action.setText("Save changes")
            self.freeze(False)
            self.title.setFocus()

        self.message("")
        self.processing("Loading…")
        self.query(lambda: fetch_definition(self.connection, self.editing), loaded)

    def create_footer(self):
        self.buttons = QWidget(self)
        footer = QHBoxLayout(self.buttons)
        self.footer = footer
        footer.setContentsMargins(0, 0, 0, 0)
        footer.setSpacing(10)
        self.close_button = QPushButton("Close")
        self.close_button.setAutoDefault(False)
        self.close_button.clicked.connect(self.reject)
        footer.addWidget(self.close_button)
        self.new_button = QPushButton("New skill")
        footer.addWidget(self.new_button)
        self.new_button.setAutoDefault(False)
        self.new_button.clicked.connect(self.new_skill)
        self.new_button.hide()
        self.preview_button = QPushButton("Preview exercises…")
        self.preview_button.setAutoDefault(False)
        self.preview_button.clicked.connect(self.preview)
        self.preview_button.hide()
        footer.addWidget(self.preview_button)
        footer.addStretch()
        self.footer_gap = footer.itemAt(footer.count() - 1)
        self.action = QPushButton("Save changes" if self.editing else "Add skill")
        footer.addWidget(self.action)
        self.action.setDefault(True)
        self.action.clicked.connect(self.perform_action)
        return self.buttons

    def retheme(self):
        style_editor(self)
        self.update()

    def active(self):
        if (
            self.closed
            or self.mw.col is not self.collection
            or self.mw.pm.profile is not self.profile
        ):
            return False
        try:
            return companion_connection() == self.connection
        except SkillImportError:
            return False

    def changed(self):
        if not hasattr(self, "action"):
            return
        editable = not self.frozen and not self.busy and not self.added
        for field in (self.title, self.description, self.example_list):
            field.setEnabled(editable)
        selected = bool(self.example_list.selectedItems()) and (
            0 <= self.example_list.currentRow() < len(self.examples)
        )
        self.add_example_button.setEnabled(editable and len(self.examples) < 5)
        self.edit_example_button.setEnabled(editable and selected)
        self.remove_example_button.setEnabled(editable and selected)
        if editable:
            self.action.setEnabled(
                bool(
                    self.title.text().strip() and self.description.toPlainText().strip()
                )
                and (
                    not self.editing
                    or self.original is not None
                    and any(
                        self.original[key] != value
                        for key, value in {
                            "title": self.title.text().strip(),
                            "description": self.description.toPlainText().strip(),
                            "examples": self.examples,
                        }.items()
                    )
                )
            )

    def freeze(self, frozen):
        self.frozen = frozen
        self.title.setReadOnly(frozen)
        self.description.setReadOnly(frozen)
        self.changed()

    def processing(self, text=None):
        self.progress.setVisible(bool(text))
        if text:
            self.action.setText(text)
            self.action.setEnabled(False)

    def refresh_examples(self):
        self.example_list.clear()
        self.example_list.addItems(
            [example["prompt"].replace("\n", " ") for example in self.examples]
        )
        has_examples = bool(self.examples)
        if not has_examples:
            empty = QListWidgetItem("No examples")
            empty.setFlags(Qt.ItemFlag.NoItemFlags)
            self.example_list.addItem(empty)
        self.example_list.setCurrentRow(-1)
        self.example_list.clearSelection()
        self.changed()

    def add_example(self):
        if self.busy or self.pending is not None or len(self.examples) >= 5:
            return
        dialog = ExampleDialog(self)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                self.examples.append(dialog.example())
                self.refresh_examples()
            except SkillImportError as error:
                showWarning(str(error), parent=self)

    def edit_example(self):
        index = self.example_list.currentRow()
        if (
            not self.example_list.selectedItems()
            or not 0 <= index < len(self.examples)
            or self.pending is not None
            or self.busy
        ):
            return
        dialog = ExampleDialog(self, self.examples[index])
        if dialog.exec() == QDialog.DialogCode.Accepted:
            try:
                self.examples[index] = dialog.example()
                self.refresh_examples()
                self.example_list.setCurrentRow(index)
            except SkillImportError as error:
                showWarning(str(error), parent=self)

    def remove_example(self):
        index = self.example_list.currentRow()
        if (
            self.example_list.selectedItems()
            and 0 <= index < len(self.examples)
            and self.pending is None
            and not self.busy
        ):
            self.examples.pop(index)
            self.refresh_examples()

    def message(self, text):
        self.status.setText(text)
        self.status.setVisible(bool(text))

    def query(self, op, success):
        self.busy = True
        self.action.setEnabled(False)
        self.changed()

        def received(value):
            self.busy = False
            if self.active():
                success(value)

        def failed(error):
            self.busy = False
            if self.active():
                self.timer.stop()
                self.processing()
                if self.pending is None and (
                    not self.editing or self.original is not None
                ):
                    self.freeze(False)
                self.message(
                    str(error)
                    if isinstance(error, SkillImportError)
                    else "The request failed. Retry later."
                )
                self.action.setText("Retry")
                self.action.setEnabled(True)
                self.changed()
                if self.editing and self.original is None:
                    self.action.setEnabled(True)

        QueryOp(parent=self.mw, op=lambda _: op(), success=received).failure(
            failed
        ).without_collection().run_in_background()

    def perform_action(self):
        if not self.active() or self.busy:
            return
        if self.added:
            if self.editing:
                self.reject()
            else:
                self.new_skill()
        elif self.snapshot is not None:
            self.add_skill()
        elif self.pending is not None:
            self.poll() if self.job_id else self.submit()
        elif self.editing and self.original is None:
            self.load_definition()
        else:
            try:
                definition = validate_definition(
                    {
                        "request_id": uuid4().hex,
                        "source_id": "00000000-0000-0000-0000-000000000000",
                        "title": self.title.text().strip(),
                        "description": self.description.toPlainText().strip(),
                        "examples": list(self.examples),
                        **(self.editing or {}),
                    }
                )
            except SkillImportError as error:
                self.message(str(error))
                return
            self.message("")
            self.freeze(True)
            self.processing("Generating…")

            def connected(snapshot):
                if self.editing:
                    try:
                        validate_edit_target(self.collection, snapshot, definition)
                    except SkillImportError as error:
                        self.processing()
                        self.message(str(error))
                        self.action.setEnabled(False)
                        return
                self.pending = {**definition, "source_id": snapshot["source_id"]}
                self.profile[PENDING_KEY] = self.pending
                self.mw.pm.save()
                self.freeze(True)
                self.submit()

            self.query(lambda: fetch_snapshot(self.connection), connected)

    def submit(self):
        if not self.active() or self.busy or self.pending is None:
            return
        self.message("")
        self.processing("Generating…")
        self.query(
            lambda: request_job(self.connection, self.pending), self.received_job
        )

    def poll(self):
        if not self.active() or self.busy or not self.job_id:
            return
        self.query(
            lambda: request_job(self.connection, self.pending, self.job_id),
            self.received_job,
        )

    def received_job(self, job):
        self.job_id = job["id"]
        state = job["state"]
        self.message("")
        if state == "completed":
            self.timer.stop()
            self.processing("Adding…")
            self.query(
                lambda: creation_snapshot(
                    fetch_snapshot(self.connection), self.pending
                ),
                self.generated,
            )
        elif state in ("failed", "obsolete", "needs_attention", "waiting_budget"):
            self.timer.stop()
            self.processing()
            self.message(STATES[state])
            self.action.setText("Check status")
            self.action.setEnabled(True)
            if state in ("failed", "obsolete"):
                self.new_button.setText("Edit")
                self.new_button.show()
        else:
            self.processing("Generating…")
            self.timer.start()

    def generated(self, snapshot):
        self.snapshot = snapshot
        self.add_skill()

    def completed(self):
        self.entry_geometry = self.geometry()
        center = self.frameGeometry().center()
        self.added = True
        self.processing()
        self.message("")
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(6)
        page.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        title = QLabel(self.snapshot["skills"][0]["title"])
        title.setTextFormat(Qt.TextFormat.PlainText)
        title.setWordWrap(True)
        font = title.font()
        font.setPointSizeF(18)
        title.setFont(font)
        layout.addWidget(title)
        layout.addWidget(
            QLabel("Changes saved." if self.editing else "Added to LearnRecur skills.")
        )
        layout.addStretch()
        self.pages.addWidget(page)
        self.pages.setCurrentIndex(1)
        self.setWindowTitle("Skill saved" if self.editing else "Skill added")
        self.new_button.hide()
        self.preview_button.show()
        self.action.setText("Done" if self.editing else "Add another skill")
        self.close_button.setVisible(not self.editing)
        self.action.setEnabled(True)
        self.footer.removeItem(self.footer_gap)
        self.footer.insertItem(0, self.footer_gap)
        self.setMinimumSize(560, 160)
        self.resize(600, 180)
        self.move(center - self.rect().center())
        page.setFocus()
        self.action.setDefault(True)

    def preview(self):
        if self.added:
            ExercisePreview(self, self.snapshot).exec()

    def new_skill(self):
        if self.busy:
            return
        keep_fields = self.snapshot is None
        was_added = self.added
        self.timer.stop()
        self.profile.pop(PENDING_KEY, None)
        self.mw.pm.save()
        self.pending = self.job_id = self.snapshot = None
        self.added = False
        self.pages.setCurrentIndex(0)
        if self.pages.count() > 1:
            old = self.pages.widget(1)
            self.pages.removeWidget(old)
            old.deleteLater()
        self.new_button.hide()
        self.new_button.setEnabled(True)
        self.preview_button.hide()
        if was_added:
            self.footer.removeItem(self.footer_gap)
            self.footer.insertItem(3, self.footer_gap)
            self.setMinimumSize(640, 500)
            self.setGeometry(self.entry_geometry)
        self.setWindowTitle("Edit skill" if self.editing else "Add skill")
        self.processing()
        self.action.setText("Save changes" if self.editing else "Add skill")
        self.message("")
        if not keep_fields:
            self.title.clear()
            self.description.clear()
            self.examples.clear()
            self.refresh_examples()
        self.freeze(False)
        self.changed()
        self.title.setFocus()

    def add_skill(self):
        if self.mw.state not in ("deckBrowser", "overview"):
            self.processing()
            self.message("Return to the deck list to save the skill.")
            self.action.setText("Finish saving" if self.editing else "Finish adding")
            self.action.setEnabled(True)
            return
        snapshot = self.snapshot
        self.busy = True
        self.processing("Adding…")
        self.new_button.setEnabled(False)

        def apply(col):
            if (
                not self.active()
                or col is not self.collection
                or self.mw.state not in ("deckBrowser", "overview")
            ):
                raise SkillImportError("The profile changed. Open Add skill again.")
            if self.editing:
                validate_edit_target(col, snapshot, self.pending, completed=True)
            return import_snapshot(col, snapshot)

        def added(_):
            self.busy = False
            if self.active():
                self.profile.pop(PENDING_KEY, None)
                self.mw.pm.save()
                self.completed()

        def failed(error):
            self.busy = False
            if self.active():
                self.processing()
                self.message(
                    str(error)
                    if isinstance(error, SkillImportError)
                    else "Could not add the skill. Retry later."
                )
                self.action.setText("Retry")
                self.action.setEnabled(True)
                self.new_button.setEnabled(True)

        CollectionOp(parent=self.mw, op=apply).success(added).failure(
            failed
        ).run_in_background()

    def done(self, result):
        if self.closed:
            return
        self.closed = True
        self.timer.stop()
        gui_hooks.profile_will_close.remove(self.reject)
        gui_hooks.theme_did_change.remove(self.retheme)
        super().done(result)


def add_skill(mw):
    if not mw.col or mw.state not in ("deckBrowser", "overview"):
        showWarning("Return to the deck list before adding a skill.", parent=mw)
        return
    existing = getattr(mw, "_learnrecur_skill_editor", None)
    if existing is not None and not existing.closed:
        existing.raise_()
        existing.activateWindow()
        return
    try:
        dialog = SkillEditor(mw)
    except SkillImportError as error:
        showWarning(str(error), parent=mw)
        return
    mw._learnrecur_skill_editor = dialog
    mw.garbage_collect_on_dialog_finish(dialog)
    dialog.show()


def edit_skill(browser):
    browser.editor.call_after_note_saved(lambda: _edit_saved_skill(browser))


def _edit_saved_skill(browser):
    mw = browser.mw
    if not mw.col or mw.state not in ("deckBrowser", "overview"):
        showWarning("Return to the deck list before editing a skill.", parent=browser)
        return
    existing = getattr(mw, "_learnrecur_skill_editor", None)
    if existing is not None and not existing.closed:
        existing.raise_()
        existing.activateWindow()
        return
    try:
        notes = browser.selected_notes()
        if len(notes) != 1:
            raise SkillImportError("Select one imported skill.")
        dialog = SkillEditor(mw, selected_skill(mw.col, notes[0]))
    except SkillImportError as error:
        showWarning(str(error), parent=browser)
        return
    mw._learnrecur_skill_editor = dialog
    mw.garbage_collect_on_dialog_finish(dialog)
    dialog.show()


def can_edit_skill(browser):
    try:
        notes = browser.selected_notes()
        if len(notes) != 1:
            return False
        selected_skill(browser.mw.col, notes[0])
        return True
    except (SkillImportError, KeyError):
        return False
