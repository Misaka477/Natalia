use crate::pane::PaneId;
use serde::{Deserialize, Serialize};
use wezterm_term::StableRowIndex;

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone, Default)]
pub struct PaneSelectionResponse {
    pub pane_id: PaneId,
    pub selection: Option<PaneSelection>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
pub struct PaneSelection {
    pub mode: String,
    pub ranges: Vec<PaneSelectionRange>,
}

#[derive(Serialize, Deserialize, PartialEq, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PaneSelectionRange {
    pub start_row: StableRowIndex,
    pub start_col: usize,
    pub end_row: StableRowIndex,
    pub end_col: usize,
}
