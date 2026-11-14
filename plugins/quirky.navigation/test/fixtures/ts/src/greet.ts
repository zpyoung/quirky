export type Name = string

export function greet(name: Name): string {
  return `hello ${name}`
}

export class Greeter {
  constructor(private readonly prefix: string) {}

  hello(name: Name): string {
    return `${this.prefix} ${greet(name)}`
  }
}
