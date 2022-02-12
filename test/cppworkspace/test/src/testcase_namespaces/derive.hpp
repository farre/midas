#pragma once
#include <string>
#include <iostream>

namespace derive
{
    static int ids = 0;
    struct Base
    {
    protected:
        int id;
        std::string name;

    public:
        Base(int id, std::string name) : id(id), name(std::move(name)) {}
        virtual ~Base() {}
        virtual void sayHello() = 0;
    };

    struct Derived : Base
    {
        Derived(std::string sub_name) : Base(ids++, "Derived"), sub_name(std::move(sub_name)) {}
        ~Derived() = default;
        std::string sub_name;
        void sayHello() override
        {
            std::cout << "[ID: " << this->id << "]: Hello my name is: " << this->name << ", " << this->sub_name << std::endl;
        }
    };

    struct IntDerived : Base
    {
        IntDerived(int sub_id) : Base(ids++, "Derived"), sub_id(sub_id) {}
        virtual ~IntDerived() = default;
        int sub_id;
        void sayHello() override
        {
            std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << std::endl;
        }

        void foo()
        {
            std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << std::endl;
        }
    };

    struct Final : public IntDerived
    {
        int m_k;
        Final(int k, int sub) : IntDerived(sub), m_k(k)
        {
        }

        void sayHello() override
        {
            std::cout << "[ID: " << this->id << ":" << this->sub_id << "]: Hello my name is: " << this->name << " and I am derived of a derived. Value: " << m_k << std::endl;
        }
    };

    void main();
} // namespace derive
