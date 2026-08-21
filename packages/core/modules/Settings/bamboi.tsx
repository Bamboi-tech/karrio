"use client";
import { BamboiFeaturesManagement } from "@karrio/ui/components/bamboi-features-management";
import { SettingsLayout } from "@karrio/ui/components/settings-layout";

export default function BamboiPage(pageProps: any) {
  const Component = (): JSX.Element => {
    return (
      <div className="min-h-screen bg-background">
        <div className="container mx-auto p-0">
          <SettingsLayout>
            <BamboiFeaturesManagement />
          </SettingsLayout>
        </div>
      </div>
    );
  };

  return <Component />;
}
