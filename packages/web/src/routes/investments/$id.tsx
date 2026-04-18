import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/investments/$id")({
  component: InvestmentDetail,
});

function InvestmentDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  return (
    <div className="space-y-2 pt-4">
      <p className="text-sm text-muted-foreground">
        Detail view coming up. Investment id: <code>{id}</code>
      </p>
      <Button
        variant="outline"
        onClick={() => void navigate({ to: "/investments" })}
      >
        Back
      </Button>
    </div>
  );
}
