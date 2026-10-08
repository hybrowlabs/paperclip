# @paperclipai/adapter-utils

## Unreleased

### Patch Changes

- Allow the Paperclip host to route adapter sandbox-sync full-tree Git enumeration through its process-wide bounded scheduler.
- Treat a Git workspace with zero commits (unborn `HEAD`) as a normal state: `readGitWorkspaceSnapshot` returns `null` (directory sync) instead of throwing, and the new `readGitHeadState` reports `{ state: "unborn", headCommit: null, branchName }`. A missing or non-directory workspace path now throws `WorkspacePathUnusableError` with the specific, non-retryable code `workspace_path_unusable`.

## 0.3.1

### Patch Changes

- Stable release preparation for 0.3.1

## 0.3.0

### Minor Changes

- Stable release preparation for 0.3.0

## 0.2.7

### Patch Changes

- Version bump (patch)

## 0.2.6

### Patch Changes

- Version bump (patch)

## 0.2.5

### Patch Changes

- Version bump (patch)

## 0.2.4

### Patch Changes

- Version bump (patch)

## 0.2.3

### Patch Changes

- Version bump (patch)

## 0.2.2

### Patch Changes

- Version bump (patch)

## 0.2.1

### Patch Changes

- Version bump (patch)
