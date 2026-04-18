import { useSuspenseQuery } from "@apollo/client/react";
import { createFileRoute, Navigate } from "@tanstack/react-router";

import { graphql } from "../../graphql";

const PlanningCurrentYearDocument = graphql(`
  query PlanningCurrentYear {
    planningYearCurrent {
      id
    }
  }
`);

export const Route = createFileRoute("/planning/")({
  component: PlanningIndex,
});

function PlanningIndex() {
  const { data } = useSuspenseQuery(PlanningCurrentYearDocument);
  const year = data.planningYearCurrent!.id;
  return <Navigate to="/planning/$year" params={{ year }} replace />;
}
