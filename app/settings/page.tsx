import SettingsForm from "@/components/settings-form";
import ThemeSettings from "@/components/theme-settings";

export default function SettingsPage(): React.ReactNode {
  return (
    <>
      <h1>Settings</h1>
      <p className="muted">
        Keys are encrypted on this machine only, at <code>~/.config/creagent/keys.enc.json</code>.
        They never leave your computer except in direct calls to each provider.
      </p>
      <SettingsForm />
      <ThemeSettings />
    </>
  );
}
