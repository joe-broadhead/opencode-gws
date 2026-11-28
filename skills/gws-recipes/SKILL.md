---
name: gws-recipes
description: Ready gws requests for everyday tasks, including recent or unread mail, replies and drafts, the week's meetings, finding, sharing or trashing Drive files and Docs, Sheets rows, and standup, meeting-prep and weekly-digest reports.
---

If Google Workspace tools are absent, run `/connect` and choose Google Workspace (or Google Workspace (<alias>) for another account). A Desktop OAuth client is needed unless your organisation provides one.

# Recipes

Copy the shape and replace the ids. `gws` covers accounts, plan then commit, and errors. Each list example asks only for what the task needs; add a field when you need one.

## Gmail

Gmail's mailbox tools are Google's Gmail MCP tools (`gws_search_threads` and the rest); they take Google's arguments, not the plugin's `{operation,...}` shape, and a send or a delete asks first. A plugin `read` of a covered Gmail operation is refused with the tool to call.

- **A time window.** Gmail's `after:` and `before:` take a date, `YYYY/MM/DD`; a whole day is `after:2026/11/03 before:2026/11/04`, and `newer_than:` takes `d`, `m` or `y`. Gmail evaluates a date at midnight in the account's time zone.
- **Who sent it.** Search with `gws_search_threads`; the threads carry up to five recent messages with sender, recipients, date and labels. For one message, `gws_get_message` with `messageFormat: "METADATA_ONLY"` skips the subject and body, and `PLAIN_TEXT` gives the text. For a whole conversation, `gws_get_thread` with the thread id.
- **Exact unread count.** `gws_list_labels` gives `threadsUnread` for each user label. For the inbox itself, the plugin's `read` still has `gmail.users.labels.get` with `fields: "messagesUnread,threadsUnread"`.

```json
{ "tool": "gws_search_threads", "arguments": { "query": "after:2026/11/03 before:2026/11/04", "pageSize": 50 } }
```

```json
{ "tool": "gws_get_message", "arguments": { "messageId": "MESSAGE_ID", "messageFormat": "METADATA_ONLY" } }
```

```json
{ "operation": "gmail.users.labels.get", "params": { "userId": "me", "id": "INBOX" }, "fields": "messagesUnread,threadsUnread" }
```

- **Send, reply, forward.** `gws_send_message` with `to`, `subject`, `body` (and `cc`, `bcc`, `htmlBody`, `attachments`); `gws_reply` with `messageId`, `body` and `replyAll`; `gws_forward` with `messageId` and `to`. They ask first; there is no plan to show, and the answer names the message and thread.
- **Draft.** `gws_create_draft` with `to`, `subject`, `body`; it reaches no one. Sending the draft later is `gws_send_message` with `draftId`.

```json
{ "tool": "gws_reply", "arguments": { "messageId": "MESSAGE_ID", "body": "Thanks, Thursday works." } }
```

## Calendar

- **Next meetings.** Always set `timeMin` to now. Without it, `orderBy: "startTime"` returns the calendar's oldest events. `timeMin` also returns events still running, such as all-day ones (`start.date`), so ask for more than you need (`maxResults: 10`) and skip those when the user means meetings. `singleEvents: true` expands recurring meetings.
- **A range, such as next week.** Set `timeMin` to Monday 00:00 and `timeMax` to the next Monday 00:00, both with the user's offset. Put `timeZone` in `fields` to learn the calendar's zone without another call. Count each event on its local start date. All-day events have `start.date`, not `start.dateTime`.
- **The helper.** `calendar.agenda` takes `today`, `tomorrow`, `week` or `days`, plus `timezone`. It is smaller than a full events list.

```json
{ "operation": "calendar.events.list", "params": { "calendarId": "primary", "timeMin": "2026-11-05T14:30:00+01:00", "singleEvents": true, "orderBy": "startTime", "maxResults": 10 }, "fields": "timeZone,items(summary,start,end,htmlLink),nextPageToken" }
```

```json
{ "operation": "calendar.agenda", "input": { "week": true, "timezone": "Europe/Amsterdam" } }
```

- **An event.** `calendar.events.insert` with `calendarId: "primary"` and a body with `summary`, `start` and `end`. It plans as write. With `sendUpdates: "all"` it emails the guests and plans as send.

## Drive and Docs

- **Search.** Drive's `q` uses clauses joined by `and`: `name contains 'budget'`, `fullText contains 'offsite'`, `'me' in owners` and `trashed = false`. A Doc is `mimeType = 'application/vnd.google-apps.document'`, and a Sheet is `mimeType = 'application/vnd.google-apps.spreadsheet'`. For "the one I edited", order by `modifiedByMeTime desc`; otherwise use `modifiedTime desc`.

```json
{ "operation": "drive.files.list", "params": { "q": "mimeType = 'application/vnd.google-apps.document' and trashed = false", "orderBy": "modifiedByMeTime desc", "pageSize": 1 }, "fields": "files(id,name,modifiedTime,webViewLink,ownedByMe,capabilities/canTrash)" }
```

- **A Doc's text.** Read it with this mask; the `table` branch keeps text inside tables. The full document is several times larger. `drive.files.export` is not a read: it writes a file to disk after a prompt, so don't use it to read a Doc.

```json
{ "operation": "docs.documents.get", "params": { "documentId": "DOCUMENT_ID" }, "fields": "title,body/content(paragraph/elements/textRun/content,table/tableRows/tableCells/content/paragraph/elements/textRun/content)" }
```

- **Edit a Doc.** `docs.documents.batchUpdate` with `{"requests": [{"insertText": {"location": {"index": 1}, "text": "..."}}]}`. Index 1 is the start of the body. It plans as write.
- **Trash (the bin).** Use `drive.files.update` with `"body": {"trashed": true}`. It plans as delete, so commit with `delete`. The owner can restore it from the trash for 30 days. People it is shared with keep access until it is permanently deleted. Only the owner can trash a file (on a shared drive, an organizer or file organizer, with `supportsAllDrives: true`). Ask for `ownedByMe` and `capabilities/canTrash` in the list, as above, so you need no extra call. `drive.files.delete` is a permanent delete that removes everyone's access, so never use it for "bin" or "trash".

```json
{ "operation": "drive.files.update", "params": { "fileId": "FILE_ID" }, "body": { "trashed": true } }
```

- **Share.** `drive.permissions.create` with `fileId` and a body such as `{"type": "user", "role": "reader", "emailAddress": "..."}`. It plans as share.
- **Upload.** `drive.files.create` with a `body` (`name`, `mimeType`) and the plugin's own top-level `"upload": {"path": "/absolute/file.pdf", "mime": "application/pdf"}`. `schema` doesn't show `upload`.

## Sheets

- **Read.** `sheets.read` with `{"spreadsheet": "ID", "range": "A1:D20"}`. A range without a sheet name reads the first sheet, so don't guess a name such as `Sheet1`.
- **Append rows.** `sheets.spreadsheets.values.append` with `range: "A1"`, `valueInputOption: "USER_ENTERED"` and `{"values": [[...]]}`. It plans as write.

## Reports

`workflow.standup-report`, `workflow.meeting-prep` and `workflow.weekly-digest` are reads. Run them with `read`, and `input: {"format": "json"}` for structured data.

```json
{ "operation": "workflow.standup-report", "input": { "format": "json" } }
```

Login activity is Admin SDK Reports. It needs an account for a Workspace admin with the Reports privilege. Any other account gets `ADMIN_PRIVILEGE_REQUIRED`, which signing in again as the same account won't fix.

```json
{ "operation": "admin-reports.activities.list", "params": { "userKey": "all", "applicationName": "login", "startTime": "2026-11-04T14:30:00Z" }, "fields": "items(actor/email,id/time,events/name),nextPageToken" }
```
