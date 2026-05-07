import { createFileRoute } from "@tanstack/react-router";

import { Home } from "../components/home/home";

/** Same component as `/`; the net-worth block-map dialog reads the path and opens itself when the user is here. Having a dedicated path means a page refresh / shared link reopens the dialog. */
export const Route = createFileRoute("/composition")({
  component: Home,
});
