import { graphql } from "../graphql";

export const MeDocument = graphql(`
  query Me {
    me {
      token
      isDemo
    }
  }
`);

export const DemosDocument = graphql(`
  query Demos {
    demos {
      id
      name
      description
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

export const DemoLoginDocument = graphql(`
  mutation DemoLogin($id: ID!) {
    demoLogin(id: $id) {
      token
    }
  }
`);

export const LogoutDocument = graphql(`
  mutation Logout {
    logout
  }
`);
