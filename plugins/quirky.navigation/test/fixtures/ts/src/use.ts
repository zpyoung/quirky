import { greet, Greeter, type Name } from './index'

const who: Name = 'world'
const label = 'héllo 🙂'; greet(who)
const greeter = new Greeter('hi')
greeter.hello(who)
export const twice = [greet(label), greeter.hello(label)]
