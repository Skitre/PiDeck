/** Maximum number of images accepted by one Agent request. */
export const MAX_AGENT_REQUEST_IMAGES = 4;

/** Maximum decoded-equivalent bytes accepted for one base64 Agent image. */
export const MAX_AGENT_IMAGE_BYTES = 5 * 1024 * 1024;

/** Maximum number of managed document attachments accepted by one Agent request. */
export const MAX_AGENT_REQUEST_ATTACHMENTS = 4;

/** Maximum bytes accepted for one managed PDF or DOCX attachment. */
export const MAX_AGENT_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Maximum combined bytes of managed documents accepted by one Agent request. */
export const MAX_AGENT_REQUEST_ATTACHMENT_BYTES = 100 * 1024 * 1024;

/** UTF-8 bytes in one clipboard text paste before Composer creates a TXT attachment. */
export const PASTED_TEXT_ATTACHMENT_THRESHOLD_BYTES = 4 * 1024;

/** Maximum UTF-8 bytes accepted by attachment.createText. */
export const MAX_PASTED_TEXT_ATTACHMENT_BYTES = 1024 * 1024;

/** Maximum UTF-8 bytes accepted for one repository-relative Git path. */
export const MAX_GIT_PATH_BYTES = 16 * 1024;

/** Maximum UTF-8 bytes accepted for a Git commit message. */
export const MAX_GIT_COMMIT_MESSAGE_BYTES = 16 * 1024;

/** Maximum changed entries returned by one Git status snapshot. */
export const MAX_GIT_STATUS_ENTRIES = 20_000;

/** Maximum stdout bytes collected from one Git status command. */
export const MAX_GIT_STATUS_OUTPUT_BYTES = 8 * 1024 * 1024;

/** Maximum patch bytes returned by one Git diff request. */
export const MAX_GIT_DIFF_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Maximum patch lines returned by one Git diff request. */
export const MAX_GIT_DIFF_LINES = 20_000;

/** Maximum UTF-8 bytes accepted for one local Git branch name. */
export const MAX_GIT_BRANCH_NAME_BYTES = 255;

/** Maximum local branches returned by one Git branch request. */
export const MAX_GIT_BRANCHES = 1_000;

/** Maximum commits accepted in one Git history page. */
export const MAX_GIT_HISTORY_PAGE_SIZE = 100;

/** Maximum stdout bytes collected from branch or history metadata commands. */
export const MAX_GIT_METADATA_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Maximum UTF-8 bytes in one Host-to-Desktop JSONL frame, including newline. */
export const MAX_HOST_JSONL_FRAME_BYTES = 32 * 1024 * 1024;

/** Character limits for one blocking Extension UI request. */
export const MAX_EXTENSION_UI_TITLE_LENGTH = 1_024;
export const MAX_EXTENSION_UI_MESSAGE_LENGTH = 65_536;
export const MAX_EXTENSION_UI_DEFAULT_VALUE_LENGTH = 65_536;
export const MAX_EXTENSION_UI_OPTIONS = 1_000;
export const MAX_EXTENSION_UI_OPTION_ID_LENGTH = 1_024;
export const MAX_EXTENSION_UI_OPTION_LABEL_LENGTH = 1_024;
export const MAX_EXTENSION_UI_OPTION_DESCRIPTION_LENGTH = 2_048;
export const MAX_EXTENSION_UI_SOURCE_LABEL_LENGTH = 120;
export const MAX_EXTENSION_UI_CORRELATION_ID_LENGTH = 256;

/** Bounds for one Host-rendered Extension message snapshot. */
export const MAX_EXTENSION_MESSAGE_RENDER_LINES = 500;
export const MAX_EXTENSION_MESSAGE_RENDER_LINE_LENGTH = 4_096;
export const MAX_EXTENSION_MESSAGE_RENDER_CHARACTERS = 128 * 1024;

/** Extension Deck settings and Host dialog-override map bounds. */
export const MAX_EXTENSION_UI_IDENTITIES = 256;
export const MAX_EXTENSION_UI_EXTENSION_ID_LENGTH = 256;
export const MAX_EXTENSION_UI_DISPLAY_NAME_LENGTH = 120;
export const MAX_EXTENSION_UI_SETTINGS_BYTES = 262_144;
export const MAX_EXTENSION_UI_FLOATS = 8;
export const MAX_EXTENSION_UI_DOCK_ORDER = 255;
export const MIN_EXTENSION_UI_DOCK_SIZE = 0.2;
export const MAX_EXTENSION_UI_DOCK_SIZE = 0.8;
