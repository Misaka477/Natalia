use codec::{GetPaneHighlightsResponse, GetPaneSelectionResponse};
use futures::future::BoxFuture;
use mux::pane::PaneId;
use mux::selection::PaneSelection;
use std::sync::Arc;
use wezterm_term::{color::ColorAttribute, StableRowIndex};

type SelectionHook =
    Arc<dyn Fn(PaneId) -> BoxFuture<'static, Option<PaneSelection>> + Send + Sync>;

lazy_static::lazy_static! {
    static ref SELECTION_HOOK: std::sync::Mutex<Option<SelectionHook>> = std::sync::Mutex::new(None);
}

pub fn set_selection_hook(hook: SelectionHook) {
    *SELECTION_HOOK.lock().unwrap() = Some(hook);
}

pub async fn query_pane_selection(pane_id: PaneId) -> Option<GetPaneSelectionResponse> {
    let hook = {
        let hook_guard = SELECTION_HOOK.lock().unwrap();
        hook_guard.as_ref()?.clone()
    };
    let selection = hook(pane_id).await;
    Some(GetPaneSelectionResponse {
        pane_id,
        selection,
    })
}

pub async fn query_pane_highlights(pane_id: PaneId) -> Option<GetPaneHighlightsResponse> {
    let mux = mux::Mux::get();
    let pane = mux.get_pane(pane_id)?;

    let dimensions = pane.get_dimensions();
    let physical_top = dimensions.physical_top;
    let viewport_range =
        physical_top..physical_top + dimensions.viewport_rows as StableRowIndex;

    let (_first_line, lines) = pane.get_lines(viewport_range);
    let mut ranges = vec![];

    for (idx, line) in lines.into_iter().enumerate() {
        let viewport_row = idx as StableRowIndex;
        let mut run_start: Option<usize> = None;

        for cell in line.visible_cells() {
            let is_highlighted = cell.attrs().reverse()
                || cell.attrs().background() != ColorAttribute::Default;
            let cell_idx = cell.cell_index();

            if is_highlighted {
                if run_start.is_none() {
                    run_start = Some(cell_idx);
                }
            } else if let Some(start) = run_start {
                ranges.push(mux::selection::PaneSelectionRange {
                    start_row: viewport_row,
                    start_col: start,
                    end_row: viewport_row,
                    end_col: cell_idx.saturating_sub(1),
                });
                run_start = None;
            }
        }

        if let Some(start) = run_start {
            ranges.push(mux::selection::PaneSelectionRange {
                start_row: viewport_row,
                start_col: start,
                end_row: viewport_row,
                end_col: dimensions.cols.saturating_sub(1),
            });
        }
    }

    Some(GetPaneHighlightsResponse {
        pane_id,
        highlights: if ranges.is_empty() {
            None
        } else {
            Some(PaneSelection {
                mode: "highlights".to_string(),
                ranges,
            })
        },
    })
}
