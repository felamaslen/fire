import GraphQLUpload from "graphql-upload/GraphQLUpload.mjs";
import type { FileUpload } from "graphql-upload/processRequest.mjs";
import type { GqlScalar } from "grats";

/** A multipart file upload, per the graphql-multipart-request-spec. Resolves to a `FileUpload` (`createReadStream`, `filename`, `mimetype`, `encoding`). @gqlScalar */
export type Upload = Promise<FileUpload>;

export const uploadScalar: GqlScalar<Upload> = {
  serialize: GraphQLUpload.serialize.bind(GraphQLUpload),
  parseValue: GraphQLUpload.parseValue.bind(GraphQLUpload),
  parseLiteral: GraphQLUpload.parseLiteral.bind(GraphQLUpload),
};
