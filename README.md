# ChatPulse Group Logic

ChatPulse Group Logic is a SillyTavern third-party extension that adds a separate ChatPulse-style group chat entrance and window. It is designed for users who want group chat behavior that is independent from SillyTavern's native group chat UI, while still reusing SillyTavern characters, character cards, world info, persona descriptions, and generation APIs.

## Features

- Independent group chat entrance and modal UI
- Local group creation, member invite, member removal, and group deletion
- System announcements when members join or leave
- Random character round-robin replies when the user sends a normal group message
- Mention-priority replies when the user sends `@Character`
- Secondary character-to-character `@` replies after the main round
- ChatPulse-style `@` autocomplete menu
- Emoji picker placeholder and red packet button in the input bar
- User red packet modal with lucky/equal packet modes
- Character red packets through hidden `[REDPACKET_SEND:...]` tags
- Immediate red packet reaction rounds
- Local red packet records and claim records
- Independent preset and regex controls for the group modal
- Private chat and other local group memory injection
- Configurable API request delays to reduce rate-limit collisions
- Recent input/output debug panel
- Clear queue, clear debug records, and clear group history actions

## Install

Clone or copy this folder into:

```text
SillyTavern/public/scripts/extensions/third-party/ChatPulseGroupLogic
```

Then restart or refresh SillyTavern and enable the extension from the Extensions panel.

## Usage

1. Open SillyTavern.
2. Enable `ChatPulse Group Logic`.
3. Click the ChatPulse group entrance button.
4. Create a local group and select members.
5. Send a message in the group modal.

Behavior:

- No `@`: group members reply in a random order.
- User `@Character`: mentioned characters reply first, then the rest continue randomly.
- Character `@Character`: the mentioned character replies after the current round.
- User sends a red packet: the red packet card appears immediately and group members react.
- Character sends a red packet: the extension parses `[REDPACKET_SEND:type|amount|count|note]`, creates a red packet card, and starts reactions.

## Notes

- This extension stores its independent groups in browser `localStorage`.
- It does not create or modify SillyTavern native group chats.
- It uses SillyTavern characters and character cards.
- It allows SillyTavern world info and persona descriptions to participate in character generation.
- It does not require the ChatPulse backend, database, city simulation, vector memory, or emotion system.

## Development

Core files:

- `manifest.json`
- `index.js`
- `style.css`

Basic syntax check:

```bash
node --check index.js
```

## License

MIT
