# Telegram Mini App — Component Architecture

Modern component-based architecture for the broker desk Telegram Mini App.
Replaces the 92 KB monolithic `ui-intl/app.js` with structured, testable, and maintainable modules.

## Architecture

```
packages/mini-app/src/
├── api/             # HTTP & Telegram WebApp API client (signed initData, auth headers)
├── state/           # Reactive state container (leads, active filters, current lead, drafts)
├── i18n/            # Localization dictionary loader (EN / RU)
├── components/      # Reusable UI components
│   ├── Header.js          # App header, active broker status, language switch
│   ├── InboxList.js       # List of leads sorted by HOT / WARM / COLD
│   ├── LeadCard.js        # Lead item preview with badge, timer, property tag
│   ├── LeadDetail.js      # Full lead view, message history, timeline
│   ├── DraftEditor.js     # AI drafts, manual editing, slots insertion
│   ├── ViewingSlots.js    # Calendar slot selector and confirmation
│   └── Toast.js           # Feedback notifications
└── index.js         # Application bootstrap & Telegram WebApp lifecycle initialization
```

## Security & Safety
1. **Zero InnerHTML**: All user-supplied text (sender name, inquiry messages, property notes) is escaped via `textContent` or sanitized DOM nodes, preventing XSS.
2. **Deterministic State**: State transitions occur through predictable actions (select lead, save draft, send, archive).
3. **Telegram Native**: Integrates with `Telegram.WebApp.MainButton`, `BackButton`, and `HapticFeedback`.
