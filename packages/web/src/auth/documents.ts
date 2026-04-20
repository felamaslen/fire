import { graphql } from "../graphql";

export const MeDocument = graphql(`
  query Me {
    me {
      token
    }
  }
`);

export const LoginDocument = graphql(`
  mutation Login($pin: Int!) {
    login(pin: $pin) {
      token
    }
  }
`);

export const LogoutDocument = graphql(`
  mutation Logout {
    logout
  }
`);
