CREATE TABLE "DemoSessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"schema" text NOT NULL,
	"flavour" text NOT NULL,
	"createdAt" timestamp with time zone DEFAULT now() NOT NULL,
	"expiresAt" timestamp with time zone NOT NULL,
	CONSTRAINT "DemoSessions_schema_unique" UNIQUE("schema")
);
