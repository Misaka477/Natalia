use clap::Parser;
use mux::pane::PaneId;
use wezterm_client::client::Client;

#[derive(Debug, Parser, Clone)]
pub struct GetSelection {
    /// Specify the target pane.
    /// The default is to use the current pane based on the
    /// environment variable WEZTERM_PANE.
    #[arg(long)]
    pane_id: Option<PaneId>,
}

impl GetSelection {
    pub async fn run(self, client: Client) -> anyhow::Result<()> {
        let pane_id = client.resolve_pane_id(self.pane_id).await?;
        let response = client
            .get_pane_selection(codec::GetPaneSelection { pane_id })
            .await?;
        let output = serde_json::json!({
            "selection": response.selection,
        });
        println!("{}", serde_json::to_string(&output)?);
        Ok(())
    }
}
