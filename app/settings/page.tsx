import SettingsForm from "@/components/settings-form";
import IngestConsole from "@/components/ingest-console";
import ThemeSettings from "@/components/theme-settings";
import AssetsTable from "@/components/assets-table";

export default function SettingsPage(): React.ReactNode {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <div className="sub">
            Keys stay encrypted on this machine and go only to their provider.
          </div>
        </div>
      </div>
      <SettingsForm />
      <h2>Ingest</h2>
      <p className="muted">
        Pull your existing posts in through Zernio or Monid — pick a back-dated
        window, or refresh up to the current moment. Ingested posts land on the
        calendar as history; analysis folds them into the brain.
      </p>
      <IngestConsole />
      <ThemeSettings />
      <AssetsTable />
    </>
  );
}
