# Mac accessibility investigation

The Browse crash remains unresolved. On September 30, 2026, the debugger caught Qt 6.11.2 reading a freed accessibility interface while macOS queried the selected cells in a table. This happens below Anki's Python code. The same signature appeared in our earlier isolated upstream Anki check.

## What we found

In a disposable profile, import the synthetic skill package, open Browse, and run an empty search. Reading the resulting accessibility tree can terminate the app with exit code 139. Opening Browse from a selected skill review also reproduced it. Timing varies: some queries return a tree with the table missing before a later query crashes.

The debugger stopped in Qt's Cocoa `accessibilitySelectedChildren` method at the virtual `isValid()` call on a selected child. The child's first word, which should point to its virtual-method table, contained an invalid address. The callers were AppKit accessibility accessors and `__AXCopyAttributeValueForHierarchy`.

The [Qt 6.11.2 source](https://github.com/qt/qtbase/blob/v6.11.2/src/plugins/platforms/cocoa/qcocoaaccessibilityelement.mm) suggests an ownership bug:

- Placeholder rows and cells share their parent table's accessibility ID.
- Creating a real cell can replace a placeholder in the row's array.
- The placeholder's destructor calls `deleteInterface(axid)` even when it uses that shared ID. Cache cleanup also deletes IDs without distinguishing placeholders from real cells.
- The selected-cell query keeps raw interface pointers while creating their Mac representations. Deleting the table can invalidate those pointers before the query finishes.

The invalid pointer is confirmed; this particular deletion path is the likely cause, not yet a validated Qt patch. A separate app loading only a standard Qt table and synthetic text also lost its table from the accessibility tree. It did not consistently reproduce the crash. No collection, reviewer, WebEngine page, or LearnRecur startup code was loaded in that check.

A [Qt Creator report](https://github.com/openai/codex/issues/41374) describes a similar selected-child crash during accessibility observation. The suspect destructor is also present in Qt 6.10.2. Switching to that version would not establish a fix.

We have not disabled accessibility, changed Qt versions, or patched native libraries in the product. A proper fix needs a tested Qt patch or an upstream release that fixes this ownership path. The earlier `--disable-renderer-accessibility` test flag is not a fix for native tables.

## The blocked data-access notification

The notification shown during this investigation was separate from the crash. At 21:53:05 local time, macOS attributed a denied Chrome app-data request to the debugger-launched LearnRecur process. The privacy logs did not expose the exact file path.

[Qt WebEngine's DRM discovery code](https://github.com/qt/qtwebengine/blob/v6.11.2/src/core/content_client_qt.cpp) checks Chrome's installation and its user-data folder for Widevine, a plugin for protected streaming media. This fits the blocked request. LearnRecur does not need that plugin.

Mac startup now supplies `--cdm-widevine-path=/dev/null/learnrecur-no-widevine` before importing Qt. An explicit path skips the fallback search. Because `/dev/null` is a file, the child path cannot contain a plugin. Existing Chromium flags remain intact; the appended setting takes precedence. The browser sandbox and accessibility settings are unchanged.

Setting this flag just before creating `QApplication` was too late: the native check still logged a Chrome request. The startup-order test now stops at the first PyQt import and checks that the policy is already set.

## Verification and next action

All 222 library tests and 191 Qt tests passed, along with the Mac package and signature check. The final build used normal launch settings and a disposable synthetic profile. Reveal, Again, and variation passed, and no Chrome app-data request appeared in the startup logs. Its manual undo check paused when the Mac locked; undo passed in the earlier rebuild and automated tests. The earlier rebuild also reproduced the crash on opening Browse, so this change must not be described as a crash fix.

Continue with local skill import while keeping this issue open. Before daily use or distribution, test a Qt ownership fix against Browse searches, selection changes, model resets, deck selection, and accessibility observation. VoiceOver behavior and a patched Qt build have not been checked. No personal Anki data or official installation was used, and no macOS access permission was granted by this investigation.
