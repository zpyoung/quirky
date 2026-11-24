export const QUIRKY_PROJECT_FIELDS = `
  id
  slugId
  name
  description
  content
  url
  color
  icon
  health
  priority
  priorityLabel
  progress
  scope
  issueCountHistory
  completedIssueCountHistory
  startDate
  targetDate
  createdAt
  updatedAt
  completedAt
  canceledAt
  startedAt
  status {
    id
    name
    type
    color
  }
  lead {
    id
    displayName
    avatarUrl
  }
  members(first: 10) {
    nodes {
      id
      displayName
      avatarUrl
    }
  }
  teams(first: 10) {
    nodes {
      id
      name
      key
    }
  }
  labels(first: 20) {
    nodes {
      id
      name
      color
    }
  }
`

export const QUIRKY_PROJECT_DETAIL_FIELDS = `
  ${QUIRKY_PROJECT_FIELDS}
  projectMilestones(first: 20) {
    nodes {
      id
      name
      status
      targetDate
      progress
    }
  }
  externalLinks(first: 20) {
    nodes {
      id
      label
      url
    }
  }
  lastUpdate {
    id
    body
    health
    url
    createdAt
    updatedAt
    user {
      id
      displayName
      avatarUrl
    }
  }
`

export const QUIRKY_ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priority
  estimate
  updatedAt
  labelIds
  state {
    name
    type
    color
  }
  team {
    id
    name
    key
  }
  assignee {
    id
    displayName
    avatarUrl
  }
  labels(first: 50) {
    nodes {
      id
      name
    }
  }
`

export const PROJECTS_QUERY = `
  query QuirkyLinearProjects($first: Int, $filter: ProjectFilter, $orderBy: PaginationOrderBy) {
    projects(first: $first, filter: $filter, orderBy: $orderBy) {
      nodes {
        ${QUIRKY_PROJECT_FIELDS}
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`

export const SEARCH_PROJECTS_QUERY = `
  query QuirkyLinearProjectSearch($term: String!, $first: Int, $after: String) {
    searchProjects(term: $term, first: $first, after: $after) {
      nodes {
        ${QUIRKY_PROJECT_FIELDS}
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`

export const PROJECT_QUERY = `
  query QuirkyLinearProject($id: String!) {
    project(id: $id) {
      ${QUIRKY_PROJECT_DETAIL_FIELDS}
    }
  }
`

export const CREATE_PROJECT_MUTATION = `
  mutation QuirkyLinearProjectCreate($input: ProjectCreateInput!) {
    projectCreate(input: $input) {
      success
      project {
        ${QUIRKY_PROJECT_DETAIL_FIELDS}
      }
    }
  }
`

export const PROJECT_ISSUES_QUERY = `
  query QuirkyLinearProjectIssues(
    $id: String!,
    $first: Int,
    $after: String,
    $orderBy: PaginationOrderBy
  ) {
    project(id: $id) {
      issues(first: $first, after: $after, orderBy: $orderBy) {
        nodes {
          ${QUIRKY_ISSUE_FIELDS}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`

export const PROJECT_TEAMS_QUERY = `
  query QuirkyLinearProjectTeams($id: String!, $first: Int, $after: String) {
    project(id: $id) {
      teams(first: $first, after: $after) {
        nodes {
          id
          name
          key
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`
