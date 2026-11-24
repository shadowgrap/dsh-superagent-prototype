# Glossary

Terms this repository uses for its sources, and the ones it must not confuse.

**Source kind** — A type of source, named by a stable id such as `github`, `gitea` or `feishu`. It is the plugin: the configuration schema, the card, the policy part, the channel and the health entries all belong to a kind.

**Source instance** — One stored configuration of a kind: whether it is enabled and its settings. In this repository a kind has exactly one instance, so the instance id equals the kind id. Anything that names a source in a thread key (`gitea:12`), a health entry (`health.gitea`) or a KV record assumes that one-to-one relation; several instances of one kind is a separate change.

**Trigger** — One message the agent must consider, produced by a source from an event: a mention, an issue, a comment, a review, a CI change. A trigger carries a deterministic id, so reading the same event twice produces no second trigger.

**Thread** — The conversation a trigger belongs to, named `<kind>:<id>`. A thread outlives triggers and is what a ticket is opened on.

**Ticket** — The unit of work for one request in a thread: the agent's session, its branch, its pull request and its outcome.

**Notification** — The platform's "something changed in a thread you watch" record. It names the thread; the content is then read from the thread's own cursor. A notification is a wake-up, never the message.

**Observation** — An opt-in switch on a repository source that admits events nobody addressed to the agent (new issues, new pull requests, comments, default-branch CI). With every switch off, a source acts only when someone addresses it.

**Full citizenship** — A source whose tickets participate in everything the panel, the executor and the assessor do: their pull request is listed, claimed, reported, closed with a notice, and their repository's files are readable.

**Repository source** — The optional capability a source kind offers when it has repositories, pull requests and files: reading a pull request, notifying when one ends, reading a file. Sources without repositories do not offer it.
